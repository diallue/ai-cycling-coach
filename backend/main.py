from fastapi import FastAPI, Depends, Response
from fastapi.middleware.cors import CORSMiddleware
import os
import re
import json
import httpx
from datetime import datetime, timedelta
from sqlalchemy import text
from sqlalchemy.orm import Session
from pydantic import BaseModel
from groq import Groq
from typing import List, Optional, Dict

from database import SessionLocal, engine, Base, get_db
import models
import workout_generator

app = FastAPI(title="AI Cycling Coach API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 1. Crear tablas en la BD
models.Base.metadata.create_all(bind=engine)


def asegurar_columnas_nuevas():
    """Añade de forma idempotente todas las columnas nuevas en tablas existentes."""
    migraciones = [
        "ALTER TABLE entrenamientos_programados ADD COLUMN IF NOT EXISTS estructura TEXT",
        "ALTER TABLE entrenamientos_programados ADD COLUMN IF NOT EXISTS tss_real INTEGER",
        "ALTER TABLE entrenamientos_programados ADD COLUMN IF NOT EXISTS actividad_completada_id VARCHAR",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS peso_actual FLOAT DEFAULT 71.0",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS lthr INTEGER DEFAULT 178",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS max_hr INTEGER DEFAULT 200",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS w_prime INTEGER",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS disponibilidad_json TEXT",
        "ALTER TABLE objetivos ADD COLUMN IF NOT EXISTS prioridad VARCHAR DEFAULT 'A'",
        "ALTER TABLE objetivos ADD COLUMN IF NOT EXISTS tipo_evento VARCHAR",
        "ALTER TABLE objetivos ADD COLUMN IF NOT EXISTS detalles_evento TEXT",
        "ALTER TABLE objetivos ADD COLUMN IF NOT EXISTS disponibilidad_semanal TEXT",
    ]
    for sql in migraciones:
        try:
            with engine.begin() as conn:
                conn.execute(text(sql))
        except Exception:
            sql_simple = sql.replace(" IF NOT EXISTS", "")
            try:
                with engine.begin() as conn:
                    conn.execute(text(sql_simple))
            except Exception:
                pass


asegurar_columnas_nuevas()

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

ATHLETE_ID = os.getenv("INTERVALS_ATHLETE_ID")
API_KEY = os.getenv("INTERVALS_API_KEY")
BASE_URL = "https://intervals.icu/api/v1/athlete"

_TELEMETRIA_CACHE = {"timestamp": None, "data": None}


@app.on_event("startup")
def asegurar_usuario_inicial():
    db = SessionLocal()
    try:
        usuario_principal = db.query(models.Usuario).filter(models.Usuario.id == 1).first()
        if not usuario_principal:
            nuevo_usuario = models.Usuario(
                id=1,
                email="diego@allue.com",
                nombre="Diego Allue",
                ftp_actual=305,
                peso_actual=71.0,
                lthr=178,
                max_hr=200
            )
            db.add(nuevo_usuario)
            db.commit()
    except Exception as e:
        print(f"Nota sobre el usuario inicial: {e}")
    finally:
        db.close()


class MensajeHistorial(BaseModel):
    rol: str
    texto: str


class MensajeChat(BaseModel):
    texto: str
    historial: Optional[List[MensajeHistorial]] = []


class CheckinDiarioPayload(BaseModel):
    fecha: Optional[str] = None
    sensacion_piernas: str = "normales"  # "frescas", "normales", "cargadas", "agotadas"
    minutos_disponibles: int = 90
    entorno: str = "Indoor"
    notas: Optional[str] = None


class DisponibilidadPayload(BaseModel):
    horas_por_dia: Dict[str, float]  # Ej: {"L": 2, "M": 2, "X": 2, "J": 2, "V": 0, "S": 5, "D": 6}


class NuevoObjetivoPayload(BaseModel):
    nombre: str
    fecha_meta: str
    prioridad: str = "B"
    tipo_evento: Optional[str] = "Gran Fondo"
    detalles_evento: Optional[str] = None


DIAS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]


def nombre_dia(fecha) -> str:
    return DIAS_ES[fecha.weekday()]


def _num(valor, defecto, minimo, maximo):
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return defecto
    return max(minimo, min(maximo, n))


def obtener_telemetria_intervals_en_vivo(db: Session, forzar: bool = False):
    """Consulta en tiempo real el perfil del ciclista y su Wellness en Intervals.icu."""
    ahora = datetime.now()
    if (
        not forzar
        and _TELEMETRIA_CACHE["data"] is not None
        and _TELEMETRIA_CACHE["timestamp"] is not None
        and (ahora - _TELEMETRIA_CACHE["timestamp"]).total_seconds() < 300
    ):
        return _TELEMETRIA_CACHE["data"]

    usuario = db.query(models.Usuario).filter(models.Usuario.id == 1).first()
    act_con_ftp = db.query(models.Activity).filter(
        models.Activity.usuario_id == 1,
        models.Activity.icu_ftp.isnot(None)
    ).order_by(models.Activity.start_date_local.desc()).first()

    ftp = (usuario.ftp_actual if usuario and usuario.ftp_actual else None) or (act_con_ftp.icu_ftp if act_con_ftp else 305)
    peso = (usuario.peso_actual if usuario and usuario.peso_actual else 71.0)
    lthr = (usuario.lthr if usuario and usuario.lthr else 178)
    max_hr = (usuario.max_hr if usuario and usuario.max_hr else 200)
    w_prime = (usuario.w_prime if usuario else None)
    hrv_rmssd = None
    resting_hr = None
    sleep_hours = None
    peso_api = None
    ctl_live = round(act_con_ftp.icu_ctl, 1) if (act_con_ftp and act_con_ftp.icu_ctl) else 0.0
    atl_live = round(act_con_ftp.icu_atl, 1) if (act_con_ftp and act_con_ftp.icu_atl) else 0.0

    if ATHLETE_ID and API_KEY:
        auth = ("API_KEY", API_KEY)
        try:
            with httpx.Client(timeout=4.5) as client_http:
                resp_ath = client_http.get(f"{BASE_URL}/{ATHLETE_ID}", auth=auth)
                if resp_ath.status_code == 200:
                    data = resp_ath.json()
                    peso_api = data.get("icu_weight") or data.get("weight")
                    if peso_api:
                        peso = round(float(peso_api), 1)
                    if data.get("icu_resting_hr"):
                        resting_hr = int(data["icu_resting_hr"])

                    sport_settings = data.get("sportSettings") or []
                    if isinstance(sport_settings, dict):
                        sport_settings = list(sport_settings.values())

                    for s in sport_settings:
                        if not isinstance(s, dict):
                            continue
                        tipos = s.get("types") or []
                        if "Ride" in tipos or "VirtualRide" in tipos or s.get("ftp"):
                            if s.get("ftp"):
                                ftp = int(s["ftp"])
                            elif s.get("indoor_ftp"):
                                ftp = int(s["indoor_ftp"])
                            if s.get("lthr"):
                                lthr = int(s["lthr"])
                            if s.get("max_hr"):
                                max_hr = int(s["max_hr"])
                            if s.get("w_prime"):
                                w_prime = int(s["w_prime"])
                            break

                oldest_w = (ahora - timedelta(days=7)).strftime("%Y-%m-%d")
                newest_w = ahora.strftime("%Y-%m-%d")
                resp_well = client_http.get(
                    f"{BASE_URL}/{BASE_URL.split('/athlete')[1] if '/athlete/' in BASE_URL else ATHLETE_ID}/wellness"
                    if False else f"{BASE_URL}/{ATHLETE_ID}/wellness",
                    params={"oldest": oldest_w, "newest": newest_w},
                    auth=auth
                )
                if resp_well.status_code == 200:
                    well_list = resp_well.json()
                    if isinstance(well_list, list) and well_list:
                        for w in reversed(well_list):
                            if not isinstance(w, dict):
                                continue
                            if w.get("weight") and not peso_api:
                                peso = round(float(w["weight"]), 1)
                            if w.get("hrv") and hrv_rmssd is None:
                                hrv_rmssd = round(float(w["hrv"]), 1)
                            if w.get("restingHR") and resting_hr is None:
                                resting_hr = int(w["restingHR"])
                            if w.get("sleepSecs") and sleep_hours is None:
                                sleep_hours = round(float(w["sleepSecs"]) / 3600.0, 1)
                            if w.get("ctl") is not None and ctl_live == 0.0:
                                ctl_live = round(float(w["ctl"]), 1)
                            if w.get("atl") is not None and atl_live == 0.0:
                                atl_live = round(float(w["atl"]), 1)

            if usuario:
                usuario.ftp_actual = ftp
                usuario.peso_actual = peso
                usuario.lthr = lthr
                usuario.max_hr = max_hr
                if w_prime:
                    usuario.w_prime = w_prime
                db.commit()
        except Exception as e:
            print(f"Aviso telemetría Intervals.icu (usando caché BD): {e}")

    resultado = {
        "ftp": int(ftp),
        "peso": float(peso),
        "wkg": round(float(ftp) / max(40.0, float(peso)), 2),
        "lthr": int(lthr),
        "max_hr": int(max_hr),
        "w_prime": w_prime,
        "hrv": hrv_rmssd,
        "resting_hr": resting_hr,
        "sleep_hours": sleep_hours,
        "ctl": ctl_live,
        "atl": atl_live,
        "tsb": round(ctl_live - atl_live, 1),
    }
    _TELEMETRIA_CACHE["timestamp"] = ahora
    _TELEMETRIA_CACHE["data"] = resultado
    return resultado


def calcular_niveles_progresion(db: Session, ftp: int):
    """Calcula los Niveles de Progresión (1.0 - 10.0 estilo TrainerRoad/Xert) a partir de las actividades reales de los últimos 60 días."""
    hace_60d = datetime.now() - timedelta(days=60)
    acts = db.query(models.Activity).filter(
        models.Activity.usuario_id == 1,
        models.Activity.start_date_local >= hace_60d
    ).all()

    if not acts:
        return {
            "resistencia_z2": 4.0,
            "tempo_torque": 3.8,
            "sweet_spot": 4.2,
            "umbral_ftp": 4.0,
            "vo2max": 3.5,
            "durabilidad_kj": 3.8,
            "distribucion": {"z1_z2_pct": 78, "z3_z4_pct": 16, "z5_pct": 6, "modelo": "Piramidal Base"}
        }

    max_horas = max(((a.moving_time or 0) / 3600.0) for a in acts)
    max_desnivel = max((a.total_elevation_gain or 0) for a in acts)
    max_tss = max((a.tss or 0) for a in acts)

    # Estimación de IF y trabajo mecánico (kJ) en cada salida
    salidas_ss = 0
    salidas_umbral = 0
    salidas_vo2 = 0
    max_kj = 0.0
    tiempo_baja = 0.0
    tiempo_media = 0.0
    tiempo_alta = 0.0

    for a in acts:
        dur_h = (a.moving_time or 0) / 3600.0
        np_act = a.normalized_power or (ftp * 0.68)
        if_act = np_act / max(150, ftp)
        kj_act = (np_act * (a.moving_time or 0)) / 1000.0
        if kj_act > max_kj:
            max_kj = kj_act

        if if_act < 0.76:
            tiempo_baja += dur_h
        elif if_act <= 0.96:
            tiempo_media += dur_h
            salidas_ss += 1
        elif if_act <= 1.04:
            tiempo_media += dur_h
            salidas_umbral += 1
        else:
            tiempo_alta += dur_h
            salidas_vo2 += 1

    total_h = max(0.1, tiempo_baja + tiempo_media + tiempo_alta)
    z1_z2_pct = round((tiempo_baja / total_h) * 100)
    z3_z4_pct = round((tiempo_media / total_h) * 100)
    z5_pct = max(0, 100 - z1_z2_pct - z3_z4_pct)
    modelo = "Polarizado 80/20" if (z1_z2_pct >= 75 and z5_pct >= z3_z4_pct) else "Piramidal Científico"

    lvl_z2 = round(min(10.0, max(2.0, 2.0 + (max_horas / 6.0) * 7.5)), 1)
    lvl_torque = round(min(10.0, max(2.0, 2.2 + (max_desnivel / 3000.0) * 7.0)), 1)
    lvl_ss = round(min(10.0, max(2.0, 3.0 + min(5.5, salidas_ss * 0.45) + (max_tss / 300.0) * 1.5)), 1)
    lvl_ftp = round(min(10.0, max(2.0, 3.0 + min(5.0, salidas_umbral * 0.6) + (salidas_ss * 0.25))), 1)
    lvl_vo2 = round(min(10.0, max(2.0, 2.8 + min(6.0, salidas_vo2 * 0.8) + (z5_pct * 0.15))), 1)
    lvl_durabilidad = round(min(10.0, max(2.0, 2.0 + (max_kj / 3500.0) * 7.5)), 1)

    return {
        "resistencia_z2": lvl_z2,
        "tempo_torque": lvl_torque,
        "sweet_spot": lvl_ss,
        "umbral_ftp": lvl_ftp,
        "vo2max": lvl_vo2,
        "durabilidad_kj": lvl_durabilidad,
        "distribucion": {
            "z1_z2_pct": z1_z2_pct,
            "z3_z4_pct": z3_z4_pct,
            "z5_pct": z5_pct,
            "modelo": modelo
        }
    }


def generar_estructura_respaldo(tipo_sesion: str, duracion_total: int):
    """Genera una estructura fisiológica exacta cuando se requiere respaldo o adaptación."""
    dur = int(duracion_total or 0)
    if dur <= 0 or "descanso" in (tipo_sesion or "").lower():
        return None

    texto = (tipo_sesion or "").lower()
    cal = max(10, round(dur * 0.15))
    enf = max(10, round(dur * 0.10))
    cuerpo = max(15, dur - cal - enf)

    if any(k in texto for k in ["30/15", "ronnestad", "rønnestad", "micro"]):
        reps = 10 if cuerpo >= 35 else 8
        usado = round(reps * 0.75)
        resto_z2 = max(5, cuerpo - usado)
        return [
            {"tipo": "continuo", "etiqueta": "Calentamiento progresivo", "duracion_min": cal, "ftp_pct": 62, "cadencia": "90 rpm"},
            {"tipo": "intervalos", "etiqueta": "Rønnestad 30/15s VO2max", "repeticiones": reps, "trabajo_min": 0.5, "trabajo_ftp_pct": 120, "trabajo_cadencia": "100 rpm", "recuperacion_min": 0.25, "recuperacion_ftp_pct": 50},
            {"tipo": "continuo", "etiqueta": "Base aeróbica Z2", "duracion_min": resto_z2, "ftp_pct": 66, "cadencia": "90 rpm"},
            {"tipo": "continuo", "etiqueta": "Enfriamiento Z1", "duracion_min": max(5, dur - (cal + usado + resto_z2)), "ftp_pct": 50, "cadencia": "85 rpm"},
        ]

    if any(k in texto for k in ["vo2", "hiit", "seiler", "series"]):
        reps = 4 if cuerpo >= 45 else 3
        trab_m = 8 if "seiler" in texto or "4x8" in texto else 4
        rec_m = 4
        pct_t = 107 if trab_m == 8 else 112
        usado = reps * (trab_m + rec_m)
        resto_z2 = max(5, cuerpo - usado)
        bloques = [
            {"tipo": "continuo", "etiqueta": "Calentamiento progresivo", "duracion_min": cal, "ftp_pct": 62, "cadencia": "90 rpm"},
            {"tipo": "intervalos", "etiqueta": f"Series VO2max ({reps}x{trab_m}m)", "repeticiones": reps, "trabajo_min": trab_m, "trabajo_ftp_pct": pct_t, "trabajo_cadencia": "95-100 rpm", "recuperacion_min": rec_m, "recuperacion_ftp_pct": 52},
        ]
        if resto_z2 >= 5:
            bloques.append({"tipo": "continuo", "etiqueta": "Rodaje aeróbico Z2", "duracion_min": resto_z2, "ftp_pct": 66, "cadencia": "90 rpm"})
        bloques.append({"tipo": "continuo", "etiqueta": "Enfriamiento Z1", "duracion_min": max(5, dur - (cal + usado + (resto_z2 if resto_z2 >= 5 else 0))), "ftp_pct": 50, "cadencia": "85 rpm"})
        return bloques

    if any(k in texto for k in ["sweet", "ss", "umbral", "ftp", "fuerza", "torque", "tempo"]):
        es_torque = "fuerza" in texto or "torque" in texto or "baja cadencia" in texto
        pct_trab = 86 if es_torque else 92
        cad_trab = "60-65 rpm" if es_torque else "88-92 rpm"
        reps = 3 if cuerpo >= 45 else 2
        trab_min = min(15, max(8, (cuerpo // reps) - 5))
        rec_min = 4
        usado = reps * (trab_min + rec_min)
        resto_z2 = max(0, cuerpo - usado)
        bloques = [
            {"tipo": "continuo", "etiqueta": "Calentamiento progresivo", "duracion_min": cal, "ftp_pct": 62, "cadencia": "90 rpm"},
            {"tipo": "intervalos", "etiqueta": "Fuerza-Resistencia Torque" if es_torque else "Sweet Spot / Umbral", "repeticiones": reps, "trabajo_min": trab_min, "trabajo_ftp_pct": pct_trab, "trabajo_cadencia": cad_trab, "recuperacion_min": rec_min, "recuperacion_ftp_pct": 55},
        ]
        if resto_z2 >= 10:
            bloques.append({"tipo": "continuo", "etiqueta": "Resistencia aeróbica Z2", "duracion_min": resto_z2, "ftp_pct": 68, "cadencia": "90 rpm"})
            enf_real = dur - (cal + usado + resto_z2)
        else:
            enf_real = dur - (cal + usado)
        bloques.append({"tipo": "continuo", "etiqueta": "Enfriamiento suave", "duracion_min": max(5, enf_real), "ftp_pct": 50, "cadencia": "85 rpm"})
        return bloques

    if "recupera" in texto or "regenera" in texto or "z1" in texto:
        return [
            {"tipo": "continuo", "etiqueta": "Activación suave Z1", "duracion_min": cal, "ftp_pct": 50, "cadencia": "90 rpm"},
            {"tipo": "continuo", "etiqueta": "Rodaje regenerativo oxigenación", "duracion_min": cuerpo, "ftp_pct": 56, "cadencia": "92-95 rpm"},
            {"tipo": "continuo", "etiqueta": "Soltar piernas", "duracion_min": enf, "ftp_pct": 48, "cadencia": "85 rpm"},
        ]

    return [
        {"tipo": "continuo", "etiqueta": "Calentamiento progresivo", "duracion_min": cal, "ftp_pct": 58, "cadencia": "90 rpm"},
        {"tipo": "continuo", "etiqueta": "Base aeróbica Z2 (FatMax)", "duracion_min": cuerpo, "ftp_pct": 68, "cadencia": "90-95 rpm"},
        {"tipo": "continuo", "etiqueta": "Enfriamiento regenerativo", "duracion_min": enf, "ftp_pct": 50, "cadencia": "85 rpm"},
    ]


def normalizar_estructura(bloques, duracion_total, tipo_sesion=""):
    """Valida y normaliza los bloques de la IA y cuadra siempre su duración exacta con duracion_total."""
    dur_total_int = int(duracion_total or 0)
    if dur_total_int <= 0:
        return None

    if not isinstance(bloques, list) or not bloques:
        return generar_estructura_respaldo(tipo_sesion, dur_total_int)

    limpios = []
    for b in bloques:
        if not isinstance(b, dict):
            continue
        etiqueta = str(b.get("etiqueta") or b.get("label") or "Bloque")[:60]
        tipo_b = str(b.get("tipo") or b.get("type") or "continuo").lower()
        if "inter" in tipo_b or b.get("repeticiones") or b.get("reps"):
            limpios.append({
                "tipo": "intervalos",
                "etiqueta": etiqueta,
                "repeticiones": int(_num(b.get("repeticiones") or b.get("reps"), 2, 1, 60)),
                "trabajo_min": round(_num(b.get("trabajo_min") or b.get("workMin"), 5, 0.1, 240), 2),
                "trabajo_ftp_pct": round(_num(b.get("trabajo_ftp_pct") or b.get("workPct"), 92, 30, 400)),
                "trabajo_cadencia": str(b.get("trabajo_cadencia") or b.get("workCadence") or "90 rpm")[:20],
                "recuperacion_min": round(_num(b.get("recuperacion_min") or b.get("restMin"), 3, 0, 120), 2),
                "recuperacion_ftp_pct": round(_num(b.get("recuperacion_ftp_pct") or b.get("restPct"), 55, 30, 150)),
            })
        else:
            limpios.append({
                "tipo": "continuo",
                "etiqueta": etiqueta,
                "duracion_min": round(_num(b.get("duracion_min") or b.get("durationMin"), 15, 1, 600)),
                "ftp_pct": round(_num(b.get("ftp_pct") or b.get("ftpPct"), 68, 30, 400)),
                "cadencia": str(b.get("cadencia") or b.get("cadence") or "90 rpm")[:20],
            })

    if not limpios:
        return generar_estructura_respaldo(tipo_sesion, dur_total_int)

    total = sum(
        b["duracion_min"] if b["tipo"] == "continuo"
        else b["repeticiones"] * (b["trabajo_min"] + b["recuperacion_min"])
        for b in limpios
    )
    ajuste = round(dur_total_int - total)
    if ajuste != 0:
        continuos = [b for b in limpios if b["tipo"] == "continuo"]
        if continuos:
            mayor = max(continuos, key=lambda b: b["duracion_min"])
            if mayor["duracion_min"] + ajuste >= 5:
                mayor["duracion_min"] += ajuste
            elif ajuste > 0:
                limpios.append({
                    "tipo": "continuo",
                    "etiqueta": "Rodaje Z2 complementario",
                    "duracion_min": ajuste,
                    "ftp_pct": 66,
                    "cadencia": "90 rpm"
                })
        elif ajuste > 0:
            limpios.insert(0, {
                "tipo": "continuo",
                "etiqueta": "Base aeróbica Z2",
                "duracion_min": ajuste,
                "ftp_pct": 66,
                "cadencia": "90 rpm"
            })
    return limpios


def cargar_estructura(texto):
    if not texto:
        return None
    try:
        datos = json.loads(texto)
    except (ValueError, TypeError):
        return None
    return datos if isinstance(datos, list) and datos else None


def estructura_a_texto_intervals(estructura):
    """Convierte los bloques al formato estricto de entrenamientos de Intervals.icu."""
    def cadencia(valor):
        limpio = str(valor or "").lower().replace("rpm", "").replace(" ", "").strip()
        return f" {limpio}rpm" if limpio else ""

    def tiempo(minutos):
        segundos = round(float(minutos) * 60)
        mins, segs = divmod(segundos, 60)
        if mins and segs:
            return f"{mins}m{segs}s"
        return f"{mins}m" if mins else f"{segs}s"

    lineas = []
    for b in estructura:
        lineas.append("")
        if b.get("tipo") == "intervalos":
            lineas.append(f"{b['etiqueta']} {b['repeticiones']}x")
            lineas.append(f"- {tiempo(b['trabajo_min'])} {b['trabajo_ftp_pct']}%{cadencia(b.get('trabajo_cadencia'))}")
            if b["recuperacion_min"] > 0:
                lineas.append(f"- {tiempo(b['recuperacion_min'])} {b['recuperacion_ftp_pct']}%")
        else:
            lineas.append(b["etiqueta"])
            lineas.append(f"- {tiempo(b['duracion_min'])} {b['ftp_pct']}%{cadencia(b.get('cadencia'))}")
    return "\n".join(lineas).strip()


def extraer_sesiones_de_json_truncado(error_str: str):
    """Si Groq corta un JSON muy largo en failed_generation, rescata todas las sesiones completas antes del corte."""
    if "failed_generation" not in error_str:
        return None
    objetos_sesion = []
    partes = error_str.split('"fecha"')
    for p in partes[1:]:
        fragmento = '{"fecha"' + p
        idx_cierre = fragmento.find('{"fecha"')
        if idx_cierre != -1:
            fragmento = fragmento[:idx_cierre]
        fragmento_limpio = fragmento.replace('\\n', '\n').replace('\\"', '"')
        m_fecha = re.search(r'"fecha"\s*:\s*"(\d{4}-\d{2}-\d{2})"', fragmento_limpio)
        m_tipo = re.search(r'"tipo_sesion"\s*:\s*"([^"]+)"', fragmento_limpio)
        m_entorno = re.search(r'"entorno"\s*:\s*"([^"]+)"', fragmento_limpio)
        m_dur = re.search(r'"duracion_minutos"\s*:\s*(\d+)', fragmento_limpio)
        m_tss = re.search(r'"tss"\s*:\s*(\d+)', fragmento_limpio)
        m_nota = re.search(r'"nota_entrenador"\s*:\s*"([^"]+)"', fragmento_limpio)
        if m_fecha and m_tipo and m_dur:
            objetos_sesion.append({
                "fecha": m_fecha.group(1),
                "tipo_sesion": m_tipo.group(1),
                "entorno": m_entorno.group(1) if m_entorno else "Outdoor",
                "duracion_minutos": int(m_dur.group(1)),
                "tss": int(m_tss.group(1)) if m_tss else 0,
                "nota_entrenador": m_nota.group(1) if m_nota else "Sesión estructurada para el bloque activo."
            })
    return objetos_sesion if objetos_sesion else None


@app.get("/")
def read_root():
    return {"status": "ok", "message": "Backend VeloCoach Pro activo y sincronizado con Intervals.icu"}


@app.get("/activities")
async def get_activities():
    oldest = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
    newest = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    url = f"{BASE_URL}/{ATHLETE_ID}/activities"
    params = {"oldest": oldest, "newest": newest}
    auth = ("API_KEY", API_KEY)

    async with httpx.AsyncClient() as client_http:
        response = await client_http.get(url, params=params, auth=auth)

    return response.json()


@app.post("/sync")
async def sync_activities(db: Session = Depends(get_db)):
    oldest = "2022-01-01T00:00:00"
    newest = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    url = f"{BASE_URL}/{ATHLETE_ID}/activities"
    params = {"oldest": oldest, "newest": newest}
    auth = ("API_KEY", API_KEY)

    try:
        async with httpx.AsyncClient(timeout=15.0) as client_http:
            response = await client_http.get(url, params=params, auth=auth)

        if response.status_code != 200:
            return {"status": "cached", "message": "Usando datos locales (Intervals.icu no responde)"}
    except Exception:
        return {"status": "cached", "message": "Usando datos locales (Error de conexión)"}

    activities_data = response.json()
    inserted_count = 0
    updated_count = 0
    auto_completed_sessions = 0

    for act in activities_data:
        if act.get("type") == "Ride" and not act.get("device_watts"):
            continue

        existing_act = db.query(models.Activity).filter(models.Activity.id == act.get("id")).first()
        act_db = existing_act or models.Activity(id=act.get("id"), usuario_id=1)

        act_db.icu_ctl = act.get("icu_ctl")
        act_db.icu_atl = act.get("icu_atl")
        act_db.name = act.get("name")
        act_db.type = act.get("type")

        if act.get("start_date_local"):
            act_db.start_date_local = datetime.fromisoformat(act.get("start_date_local").replace("Z", ""))

        act_db.moving_time = act.get("moving_time")
        act_db.distance = act.get("distance")
        act_db.total_elevation_gain = act.get("total_elevation_gain")
        act_db.tss = act.get("icu_training_load")
        act_db.normalized_power = act.get("icu_weighted_avg_watts")
        act_db.average_heartrate = act.get("average_heartrate")
        act_db.icu_ftp = act.get("icu_ftp")
        act_db.is_race = act.get("race", False)

        if existing_act:
            updated_count += 1
        else:
            db.add(act_db)
            inserted_count += 1

        if act_db.start_date_local and (act_db.moving_time or 0) > 900:
            fecha_act = act_db.start_date_local.date()
            sesion_prog = db.query(models.EntrenamientoProgramado).filter(
                models.EntrenamientoProgramado.usuario_id == 1,
                models.EntrenamientoProgramado.fecha_programada == fecha_act
            ).first()
            if sesion_prog and sesion_prog.duracion_minutos_planeada > 0:
                sesion_prog.estado = "Completado"
                sesion_prog.tss_real = int(act_db.tss or 0)
                sesion_prog.actividad_completada_id = str(act_db.id)
                auto_completed_sessions += 1

    db.commit()
    obtener_telemetria_intervals_en_vivo(db, forzar=True)

    return {
        "status": "success",
        "inserted": inserted_count,
        "updated": updated_count,
        "auto_completed": auto_completed_sessions,
        "total_processed": len(activities_data)
    }


@app.post("/api/disponibilidad")
def guardar_disponibilidad_semanal(payload: DisponibilidadPayload, db: Session = Depends(get_db)):
    """Guarda en PostgreSQL las horas máximas disponibles por día de la semana (L a D)."""
    orden = ["L", "M", "X", "J", "V", "S", "D"]
    partes = []
    total_h = 0.0
    for d in orden:
        h = round(float(payload.horas_por_dia.get(d, 0)), 1)
        total_h += h
        h_str = f"{int(h)}h" if h.is_integer() else f"{h}h"
        partes.append(f"{d}={h_str}")
    resumen_disp = f"{', '.join(partes)} (Total máx: {round(total_h, 1)}h/sem)"

    usuario = db.query(models.Usuario).filter(models.Usuario.id == 1).first()
    if usuario:
        usuario.disponibilidad_json = resumen_disp

    obj = db.query(models.Objetivo).filter(
        models.Objetivo.usuario_id == 1,
        models.Objetivo.activo == True
    ).order_by(models.Objetivo.prioridad.asc()).first()
    if obj:
        obj.disponibilidad_semanal = resumen_disp

    db.commit()
    return {"status": "success", "disponibilidad": resumen_disp}


@app.post("/api/objetivos")
def crear_o_actualizar_objetivo(payload: NuevoObjetivoPayload, db: Session = Depends(get_db)):
    """Permite añadir objetivos principales (A), secundarios (B) o preparatorios (C) desde la app."""
    try:
        fecha_dt = datetime.strptime(payload.fecha_meta.strip(), "%Y-%m-%d").date()
        prio = (payload.prioridad or "B").upper()[:1]
        nuevo = models.Objetivo(
            usuario_id=1,
            nombre=payload.nombre.strip(),
            fecha_meta=fecha_dt,
            prioridad=prio,
            tipo_evento=payload.tipo_evento,
            detalles_evento=payload.detalles_evento,
            activo=True
        )
        db.add(nuevo)
        db.commit()
        db.refresh(nuevo)
        return {"status": "success", "id": nuevo.id, "nombre": nuevo.nombre, "prioridad": nuevo.prioridad}
    except Exception as e:
        db.rollback()
        return {"error": str(e)}


@app.delete("/api/objetivos/{objetivo_id}")
def eliminar_objetivo(objetivo_id: int, db: Session = Depends(get_db)):
    obj = db.query(models.Objetivo).filter(
        models.Objetivo.id == objetivo_id,
        models.Objetivo.usuario_id == 1
    ).first()
    if not obj:
        return {"error": "Objetivo no encontrado"}
    obj.activo = False
    db.commit()
    return {"status": "success"}


@app.post("/api/checkin")
def checkin_diario_adaptativo(payload: CheckinDiarioPayload, db: Session = Depends(get_db)):
    """Adapta al instante el entrenamiento de hoy según la disponibilidad real del día y la fatiga muscular (estilo Join Cycling)."""
    try:
        fecha_obj = (
            datetime.strptime(payload.fecha.strip(), "%Y-%m-%d").date()
            if payload.fecha else datetime.now().date()
        )
        obj = db.query(models.Objetivo).filter(
            models.Objetivo.usuario_id == 1,
            models.Objetivo.activo == True
        ).order_by(models.Objetivo.prioridad.asc()).first()

        sesion_db = db.query(models.EntrenamientoProgramado).filter(
            models.EntrenamientoProgramado.usuario_id == 1,
            models.EntrenamientoProgramado.fecha_programada == fecha_obj
        ).first()

        if not sesion_db:
            sesion_db = models.EntrenamientoProgramado(
                usuario_id=1,
                objetivo_id=obj.id if obj else None,
                fecha_programada=fecha_obj,
                estado="Pendiente"
            )
            db.add(sesion_db)

        min_disp = max(0, int(payload.minutos_disponibles))
        sensacion = (payload.sensacion_piernas or "normales").lower()
        entorno = payload.entorno or "Indoor"

        if min_disp == 0 or sensacion == "agotadas":
            sesion_db.tipo_sesion = "Descanso Total (Adaptado por Check-in)"
            sesion_db.duracion_minutos_planeada = 0
            sesion_db.tss_planeado = 0
            sesion_db.entorno = entorno
            sesion_db.estructura = None
            sesion_db.motivo_adaptacion = (
                "Check-in diario: Supercompensación y descanso pasivo por fatiga elevada o falta de tiempo hoy."
            )
        elif sensacion == "cargadas":
            dur_real = min(min_disp, 75)
            sesion_db.tipo_sesion = f"Z1/Z2 Regenerativo Activo ({dur_real}m)"
            sesion_db.duracion_minutos_planeada = dur_real
            sesion_db.tss_planeado = round((dur_real / 60.0) * 35)
            sesion_db.entorno = entorno
            estructura = generar_estructura_respaldo("Regenerativo Z1", dur_real)
            sesion_db.estructura = json.dumps(estructura, ensure_ascii=False)
            sesion_db.motivo_adaptacion = (
                f"Check-in diario (piernas cargadas): Se reduce la carga neuromúscular a rodaje regenerativo al 50-58% FTP durante {dur_real} min."
            )
        elif sensacion == "frescas":
            if min_disp <= 75:
                tipo_nuevo = f"Micro-intervalos Rønnestad 30/15s ({min_disp}m)"
                tss_nuevo = round((min_disp / 60.0) * 78)
            elif min_disp <= 135:
                tipo_nuevo = f"Sweet Spot Progresivo + Z2 ({min_disp}m)"
                tss_nuevo = round((min_disp / 60.0) * 72)
            else:
                tipo_nuevo = f"Fondo Z2 + Durabilidad Final Sweet Spot ({min_disp}m)"
                tss_nuevo = round((min_disp / 60.0) * 64)
            sesion_db.tipo_sesion = tipo_nuevo
            sesion_db.duracion_minutos_planeada = min_disp
            sesion_db.tss_planeado = tss_nuevo
            sesion_db.entorno = entorno
            estructura = generar_estructura_respaldo(tipo_nuevo, min_disp)
            sesion_db.estructura = json.dumps(estructura, ensure_ascii=False)
            sesion_db.motivo_adaptacion = (
                f"Check-in diario (piernas frescas, {min_disp} min disponibles en {entorno}): Estímulo de calidad optimizado para aprovechar tu ventana de alta disponibilidad fisiológica."
            )
        else:
            # Sensaciones normales: ajustamos la sesión actual a los minutos exactos disponibles hoy
            nombre_base = sesion_db.tipo_sesion or "Base Aeróbica Z2 + Tempo"
            if "descanso" in nombre_base.lower():
                nombre_base = "Base Aeróbica Z2 (FatMax)"
            sesion_db.tipo_sesion = f"{nombre_base.split('(')[0].strip()} ({min_disp}m)"
            sesion_db.duracion_minutos_planeada = min_disp
            sesion_db.tss_planeado = round((min_disp / 60.0) * 58)
            sesion_db.entorno = entorno
            estructura = normalizar_estructura(cargar_estructura(sesion_db.estructura), min_disp, sesion_db.tipo_sesion)
            sesion_db.estructura = json.dumps(estructura, ensure_ascii=False) if estructura else None
            sesion_db.motivo_adaptacion = (
                f"Check-in diario: Duración reajustada exactamente a tus {min_disp} min disponibles hoy en {entorno} manteniendo el estímulo del bloque activo."
            )

        db.commit()
        return {"status": "success", "sesion": sesion_db.tipo_sesion, "duracion": sesion_db.duracion_minutos_planeada}
    except Exception as e:
        db.rollback()
        return {"error": str(e)}


@app.post("/chat")
def chat_entrenador(mensaje: MensajeChat, db: Session = Depends(get_db)):
    try:
        hoy_dt = datetime.now()
        hoy_date = hoy_dt.date()

        telemetria = obtener_telemetria_intervals_en_vivo(db)
        ftp_actual = telemetria["ftp"]
        peso_actual = telemetria["peso"]
        wkg_actual = telemetria["wkg"]
        lthr_actual = telemetria["lthr"]
        ctl_actual = telemetria["ctl"]
        atl_actual = telemetria["atl"]
        tsb_actual = telemetria["tsb"]

        niveles = calcular_niveles_progresion(db, ftp_actual)
        usuario_db = db.query(models.Usuario).filter(models.Usuario.id == 1).first()

        hace_un_ano = hoy_dt - timedelta(days=365)
        hace_4_semanas = hoy_dt - timedelta(days=28)

        acts_ano = db.query(models.Activity).filter(
            models.Activity.usuario_id == 1,
            models.Activity.start_date_local >= hace_un_ano
        ).all()

        horas_ultimo_ano = round(sum((a.moving_time or 0) for a in acts_ano) / 3600, 1)
        desnivel_ultimo_ano = int(sum((a.total_elevation_gain or 0) for a in acts_ano))

        salida_mas_larga_h = 0.0
        salida_mas_larga_desnivel = 0
        if acts_ano:
            act_record = max(acts_ano, key=lambda x: (x.total_elevation_gain or 0))
            salida_mas_larga_h = round((act_record.moving_time or 0) / 3600, 1)
            salida_mas_larga_desnivel = int(act_record.total_elevation_gain or 0)

        acts_recientes = [a for a in acts_ano if a.start_date_local and a.start_date_local >= hace_4_semanas]
        media_horas_ultimas_4_sem = round(sum((a.moving_time or 0) for a in acts_recientes) / 3600 / 4, 1)

        objetivos_activos = db.query(models.Objetivo).filter(
            models.Objetivo.usuario_id == 1,
            models.Objetivo.activo == True
        ).order_by(models.Objetivo.prioridad.asc(), models.Objetivo.fecha_meta.asc()).all()

        obj_principal = objetivos_activos[0] if objetivos_activos else None
        disponibilidad_guardada = (
            (usuario_db.disponibilidad_json if usuario_db and usuario_db.disponibilidad_json else None)
            or (obj_principal.disponibilidad_semanal if obj_principal and obj_principal.disponibilidad_semanal else None)
            or "No especificada aún"
        )

        fases_db = []
        fase_activa_hoy = None
        if obj_principal:
            fases_db = db.query(models.FaseMacrociclo).filter(
                models.FaseMacrociclo.usuario_id == 1,
                models.FaseMacrociclo.objetivo_id == obj_principal.id
            ).order_by(models.FaseMacrociclo.orden.asc()).all()
            for f in fases_db:
                if f.fecha_inicio <= hoy_date <= f.fecha_fin:
                    fase_activa_hoy = f
                    break
            if not fase_activa_hoy and fases_db:
                fase_activa_hoy = fases_db[0]

        sesiones_proximas = db.query(models.EntrenamientoProgramado).filter(
            models.EntrenamientoProgramado.usuario_id == 1,
            models.EntrenamientoProgramado.fecha_programada >= hoy_date
        ).order_by(models.EntrenamientoProgramado.fecha_programada.asc()).limit(7).all()

        def estructurar_macrociclo(
            objetivo,
            fecha_meta,
            resumen_estrategico,
            fases=[],
            prioridad="A",
            tipo_evento=None,
            disponibilidad_semanal=None
        ):
            try:
                fecha_meta_dt = datetime.strptime(fecha_meta.strip(), "%Y-%m-%d").date()
                prio_limpia = (prioridad or "A").upper()[:1]

                obj = db.query(models.Objetivo).filter(
                    models.Objetivo.usuario_id == 1,
                    models.Objetivo.activo == True,
                    models.Objetivo.prioridad == prio_limpia
                ).first()

                if not obj and prio_limpia == "A":
                    obj = db.query(models.Objetivo).filter(
                        models.Objetivo.usuario_id == 1,
                        models.Objetivo.activo == True
                    ).first()

                if not obj:
                    obj = models.Objetivo(
                        usuario_id=1,
                        nombre=objetivo,
                        fecha_meta=fecha_meta_dt,
                        prioridad=prio_limpia,
                        tipo_evento=tipo_evento,
                        disponibilidad_semanal=disponibilidad_semanal,
                        activo=True
                    )
                    db.add(obj)
                    db.commit()
                    db.refresh(obj)
                else:
                    obj.nombre = objetivo
                    obj.fecha_meta = fecha_meta_dt
                    obj.prioridad = prio_limpia
                    if tipo_evento:
                        obj.tipo_evento = tipo_evento
                    if disponibilidad_semanal:
                        obj.disponibilidad_semanal = disponibilidad_semanal

                if disponibilidad_semanal and usuario_db:
                    usuario_db.disponibilidad_json = disponibilidad_semanal

                if fases:
                    db.query(models.FaseMacrociclo).filter(
                        models.FaseMacrociclo.usuario_id == 1,
                        models.FaseMacrociclo.objetivo_id == obj.id
                    ).delete()

                    for idx, f in enumerate(fases):
                        nueva_fase = models.FaseMacrociclo(
                            usuario_id=1,
                            objetivo_id=obj.id,
                            orden=idx + 1,
                            nombre=f.get("nombre", f"Fase {idx + 1}"),
                            fecha_inicio=datetime.strptime(f["fecha_inicio"].strip(), "%Y-%m-%d").date(),
                            fecha_fin=datetime.strptime(f["fecha_fin"].strip(), "%Y-%m-%d").date(),
                            descripcion=f.get("descripcion", ""),
                            foco_fisiologico=f.get("foco_fisiologico", ""),
                            resumen_estrategico=resumen_estrategico if idx == 0 else None
                        )
                        db.add(nueva_fase)

                db.commit()
                return {
                    "resultado": f"Macrociclo para '{objetivo}' (Prioridad {prio_limpia}, meta {fecha_meta}) guardado en BD con {len(fases)} bloques."
                }
            except Exception as e:
                db.rollback()
                return {"error": str(e)}

        def actualizar_calendario(objetivo=None, fecha_meta=None, disponibilidad_semanal=None, sesiones=[]):
            try:
                obj = obj_principal
                if not obj:
                    fecha_dt = (
                        datetime.strptime(fecha_meta.strip(), "%Y-%m-%d").date()
                        if fecha_meta else (hoy_date + timedelta(days=120))
                    )
                    obj = models.Objetivo(
                        usuario_id=1,
                        nombre=objetivo or "Objetivo Principal",
                        fecha_meta=fecha_dt,
                        prioridad="A",
                        disponibilidad_semanal=disponibilidad_semanal,
                        activo=True
                    )
                    db.add(obj)
                    db.commit()
                    db.refresh(obj)
                else:
                    if objetivo:
                        obj.nombre = objetivo
                    if fecha_meta:
                        obj.fecha_meta = datetime.strptime(fecha_meta.strip(), "%Y-%m-%d").date()
                    if disponibilidad_semanal:
                        obj.disponibilidad_semanal = disponibilidad_semanal

                if disponibilidad_semanal and usuario_db:
                    usuario_db.disponibilidad_json = disponibilidad_semanal

                resumen_guardado = []
                for s in sesiones:
                    fecha_obj = datetime.strptime(s["fecha"].strip(), "%Y-%m-%d").date()
                    sesion_db = db.query(models.EntrenamientoProgramado).filter(
                        models.EntrenamientoProgramado.usuario_id == 1,
                        models.EntrenamientoProgramado.fecha_programada == fecha_obj
                    ).first()
                    if not sesion_db:
                        sesion_db = models.EntrenamientoProgramado(
                            usuario_id=1,
                            objetivo_id=obj.id,
                            fecha_programada=fecha_obj
                        )
                        db.add(sesion_db)
                    else:
                        sesion_db.objetivo_id = obj.id

                    dur_min = int(s.get("duracion_minutos", 0))
                    tipo_ses = s.get("tipo_sesion", "Descanso" if dur_min == 0 else "Entrenamiento Estructurado")
                    sesion_db.tipo_sesion = tipo_ses
                    sesion_db.entorno = s.get("entorno", "Indoor" if dur_min <= 120 else "Outdoor")
                    sesion_db.duracion_minutos_planeada = dur_min
                    sesion_db.tss_planeado = int(s.get("tss", round(dur_min * 0.65))) if dur_min > 0 else 0
                    sesion_db.estado = s.get("estado", "Pendiente")

                    estructura = normalizar_estructura(s.get("bloques"), dur_min, tipo_ses)
                    sesion_db.estructura = json.dumps(estructura, ensure_ascii=False) if estructura else None
                    if s.get("nota_entrenador"):
                        sesion_db.motivo_adaptacion = s.get("nota_entrenador")

                    resumen_guardado.append({
                        "fecha": s["fecha"],
                        "dia": nombre_dia(fecha_obj),
                        "entorno": sesion_db.entorno,
                        "sesion": sesion_db.tipo_sesion,
                        "duracion_min": sesion_db.duracion_minutos_planeada,
                        "tss": sesion_db.tss_planeado,
                        "bloques": estructura or []
                    })
                db.commit()
                return {
                    "resultado": "Sesiones semanales guardadas en BD con éxito.",
                    "guardado": resumen_guardado
                }
            except Exception as e:
                db.rollback()
                return {"error": str(e)}

        tools = [
            {
                "type": "function",
                "function": {
                    "name": "estructurar_macrociclo",
                    "description": "Crea o actualiza un objetivo de la temporada (prioridad A, B o C) y su plan completo de preparación por bloques/fases desde hoy hasta fecha_meta.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "objetivo": {"type": "string", "description": "Nombre del objetivo elegido por el usuario."},
                            "fecha_meta": {"type": "string", "description": "Fecha en formato YYYY-MM-DD."},
                            "prioridad": {"type": "string", "enum": ["A", "B", "C"], "description": "A=Principal, B=Secundario, C=Preparatorio."},
                            "disponibilidad_semanal": {"type": "string", "description": "Disponibilidad del usuario por días (ej. 'L-J=2h, V=0h, S-D=6h')."},
                            "resumen_estrategico": {"type": "string", "description": "Diagnóstico de 2 párrafos citando métricas históricas reales y la estrategia."},
                            "bloques": {
                                "type": "array",
                                "description": "Entre 4 y 7 bloques cronológicos desde hoy hasta fecha_meta.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "nombre": {"type": "string"},
                                        "fecha_inicio": {"type": "string", "description": "YYYY-MM-DD"},
                                        "fecha_fin": {"type": "string", "description": "YYYY-MM-DD"},
                                        "descripcion": {"type": "string"},
                                        "foco_fisiologico": {"type": "string"}
                                    },
                                    "required": ["nombre", "fecha_inicio", "fecha_fin", "descripcion"]
                                }
                            }
                        },
                        "required": ["objetivo", "fecha_meta", "resumen_estrategico", "bloques"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "actualizar_calendario",
                    "description": "Guarda o modifica en la base de datos las sesiones de entrenamiento de la semana.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "disponibilidad_semanal": {"type": "string", "description": "Si el usuario indicó horas disponibles, guárdalas aquí."},
                            "sesiones": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "fecha": {"type": "string", "description": "YYYY-MM-DD"},
                                        "tipo_sesion": {"type": "string"},
                                        "entorno": {"type": "string", "description": "'Indoor' o 'Outdoor'"},
                                        "duracion_minutos": {"type": "integer"},
                                        "tss": {"type": "integer"},
                                        "nota_entrenador": {"type": "string"},
                                        "bloques": {
                                            "type": "array",
                                            "description": "MÁXIMO 3 o 4 bloques por sesión (1. Calentamiento, 2. Parte principal agrupando series con 'repeticiones', 3. Bloque extra opcional, 4. Enfriamiento). PROHIBIDO duplicar bloques de 1 repetición.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "tipo": {"type": "string", "enum": ["continuo", "intervalos"]},
                                                    "etiqueta": {"type": "string"},
                                                    "duracion_min": {"type": "integer"},
                                                    "ftp_pct": {"type": "integer"},
                                                    "cadencia": {"type": "string"},
                                                    "repeticiones": {"type": "integer"},
                                                    "trabajo_min": {"type": "number"},
                                                    "trabajo_ftp_pct": {"type": "integer"},
                                                    "trabajo_cadencia": {"type": "string"},
                                                    "recuperacion_min": {"type": "number"},
                                                    "recuperacion_ftp_pct": {"type": "integer"}
                                                },
                                                "required": ["tipo", "etiqueta"]
                                            }
                                        }
                                    },
                                    "required": ["fecha", "tipo_sesion", "duracion_minutos"]
                                }
                            }
                        },
                        "required": ["sesiones"]
                    }
                }
            }
        ]

        dias_hasta_domingo = 6 - hoy_dt.weekday()
        fechas_validas = [hoy_dt + timedelta(days=i) for i in range(dias_hasta_domingo + 1)]
        fechas_validas_str = ", ".join(f"{d.strftime('%Y-%m-%d')} ({nombre_dia(d)})" for d in fechas_validas)

        if objetivos_activos:
            txt_objetivos = " | ".join(
                f"[Prioridad {o.prioridad}] {o.nombre} ({o.fecha_meta})" for o in objetivos_activos
            )
        else:
            txt_objetivos = "Ninguno configurado aún."

        if fase_activa_hoy:
            txt_bloque_hoy = (
                f"Bloque activo hoy: '{fase_activa_hoy.nombre}' ({fase_activa_hoy.fecha_inicio} a {fase_activa_hoy.fecha_fin}) "
                f"- Foco: {fase_activa_hoy.foco_fisiologico or fase_activa_hoy.descripcion}"
            )
        else:
            txt_bloque_hoy = "Sin bloques de macrociclo activos aún."

        if sesiones_proximas:
            txt_sesiones_bd = "; ".join(
                f"{s.fecha_programada} ({nombre_dia(s.fecha_programada)}): {s.tipo_sesion} ({s.duracion_minutos_planeada}m, {s.tss_planeado} TSS, {s.estado})"
                for s in sesiones_proximas
            )
        else:
            txt_sesiones_bd = "Ninguna sesión programada para esta semana."

        wellness_extra = ""
        if telemetria.get("hrv") or telemetria.get("sleep_hours") or telemetria.get("resting_hr"):
            wellness_extra = (
                f"- Wellness hoy (Intervals.icu): HRV={telemetria.get('hrv') or 'N/A'} ms | "
                f"FC Reposo={telemetria.get('resting_hr') or 'N/A'} bpm | Sueño={telemetria.get('sleep_hours') or 'N/A'} h.\n"
            )

        system_prompt = (
            f"Hoy es {nombre_dia(hoy_dt)} {hoy_dt.strftime('%Y-%m-%d')}.\n"
            "Eres el Director Deportivo y Fisiólogo Jefe de Diego Allue. Diseñas entrenamientos basados en evidencia científica moderna (Seiler, Rønnestad, Issurin, San Millán, Jeukendrup) y en sus datos reales de Intervals.icu.\n\n"
            "📊 TELEMETRÍA EN VIVO Y NIVELES DE PROGRESIÓN (1.0 a 10.0):\n"
            f"- FTP actual: {ftp_actual}W | Peso: {peso_actual} kg ({wkg_actual} W/kg) | LTHR: {lthr_actual} bpm | FC Máx: {telemetria['max_hr']} bpm.\n"
            f"- Carga actual: Fitness (CTL) {ctl_actual} | Fatiga (ATL) {atl_actual} | Frescura (TSB) {tsb_actual}.\n"
            f"{wellness_extra}"
            f"- Niveles de Progresión del Atleta: Resistencia Z2={niveles['resistencia_z2']}/10 | Torque/Fuerza={niveles['tempo_torque']}/10 | Sweet Spot={niveles['sweet_spot']}/10 | Umbral FTP={niveles['umbral_ftp']}/10 | VO2max={niveles['vo2max']}/10 | Durabilidad={niveles['durabilidad_kj']}/10.\n"
            f"- Últimos 365 días: {horas_ultimo_ano} h y {desnivel_ultimo_ano:,} m desnivel | Salida récord: {salida_mas_larga_h} h ({salida_mas_larga_desnivel:,} m) | Últimas 4 sem: {media_horas_ultimas_4_sem} h/sem.\n\n"
            "🧠 MEMORIA PERSISTENTE EN BASE DE DATOS:\n"
            f"- Objetivos de la temporada: {txt_objetivos}\n"
            f"- Disponibilidad semanal guardada: {disponibilidad_guardada}\n"
            f"- {txt_bloque_hoy}\n"
            f"- Agenda actual en BD: {txt_sesiones_bd}\n\n"
            "🔬 PROTOCOLOS CIENTÍFICOS DE PRESCRIPCIÓN:\n"
            "- Si el volumen semanal disponible es <8h, aplica distribución Piramidal/Sweet Spot; si es >10h, prioriza distribución Polarizada 80/20 (Seiler).\n"
            "- Usa protocolos probados: Seiler 4x8m al 106-108% FTP (rec 4m), Rønnestad 30/15s al 120%/50% FTP, Torque específico en subida a 60-65 rpm (85-88% FTP), FatMax/Z2 constante (65-72% FTP a 90-95 rpm) y Durabilidad en fatiga (bloques de Sweet Spot/Umbral en la última hora tras >1.800 kJ de Z2).\n"
            "- Si hay un objetivo secundario (Prioridad B) en la semana actual, aplica un mini-taper de 3 días previos con activaciones neuromusculares.\n\n"
            "REGLAS DE EJECUCIÓN:\n"
            "1. MACROCICLO Y MULTI-OBJETIVO: Si pide estructurar el macrociclo y aún no tienes fecha meta o disponibilidad, haz 3 preguntas breves. Si ya las tienes, llama a 'estructurar_macrociclo'.\n"
            f"2. PLANIFICACIÓN SEMANAL: Para programar esta semana, las fechas válidas desde hoy hasta el domingo son: [{fechas_validas_str}]. Respeta la disponibilidad diaria como TOPE (días con 0h = 'Descanso', duracion_minutos=0).\n"
            "3. REGLA CRÍTICA PARA 'bloques' EN 'actualizar_calendario': Incluye SIEMPRE entre 2 y 4 bloques por sesión agrupando series con 'repeticiones': N.\n"
            "4. FORMATO DE RESPUESTA AL PROGRAMAR SEMANA: Después de llamar a 'actualizar_calendario', responde SIEMPRE al usuario con:\n"
            "### 🗓 Planificación Semanal\n"
            "(Tabla Markdown: Día | Entorno | Duración | Sesión | TSS | Enfoque del Bloque)\n\n"
            "### 🔬 Análisis Fisiológico y Ejecución\n"
            f"(Desglose por día con los bloques exactos y RANGOS de vatios calculados sobre su FTP de {ftp_actual}W).\n\n"
            "### 💡 Pro-Tips del Coach\n"
            "(2 o 3 consejos científicos de nutrición CHO g/h, sodio o cadencia)."
        )

        mensajes = [{"role": "system", "content": system_prompt}]
        if mensaje.historial:
            for msg in mensaje.historial[-4:]:
                role = "assistant" if msg.rol == "ia" else "user"
                texto_recortado = msg.texto[:700] + "..." if len(msg.texto) > 700 else msg.texto
                mensajes.append({"role": role, "content": texto_recortado})
        mensajes.append({"role": "user", "content": mensaje.texto})

        herramienta_ejecutada = False

        for _ in range(2):
            try:
                kwargs_groq = {
                    "model": "openai/gpt-oss-120b",
                    "messages": mensajes,
                    "max_tokens": 2200,
                }
                if not herramienta_ejecutada:
                    kwargs_groq["tools"] = tools
                    kwargs_groq["tool_choice"] = "auto"

                respuesta_ia = client.chat.completions.create(**kwargs_groq)
            except Exception as err_groq:
                err_str = str(err_groq)
                sesiones_rescatadas = extraer_sesiones_de_json_truncado(err_str)
                if sesiones_rescatadas:
                    res_emergencia = actualizar_calendario(sesiones=sesiones_rescatadas)
                    mensajes.append({
                        "role": "system",
                        "content": (
                            f"Las sesiones ya se han guardado automáticamente en la BD: {json.dumps(res_emergencia['guardado'], ensure_ascii=False)}. "
                            "Redacta ahora directamente la respuesta completa para el usuario con la Tabla Markdown (### 🗓 Planificación Semanal), "
                            "el ### 🔬 Análisis Fisiológico y Ejecución y los ### 💡 Pro-Tips del Coach."
                        )
                    })
                    resp_final = client.chat.completions.create(
                        model="openai/gpt-oss-120b",
                        messages=mensajes,
                        max_tokens=2000
                    )
                    return {"respuesta": resp_final.choices[0].message.content}
                raise err_groq

            msg_ia = respuesta_ia.choices[0].message
            mensajes.append(msg_ia.model_dump(exclude_unset=True))

            if not msg_ia.tool_calls:
                return {"respuesta": msg_ia.content or "Plan actualizado correctamente."}

            for tool_call in msg_ia.tool_calls:
                func_name = tool_call.function.name
                args = json.loads(tool_call.function.arguments)

                if func_name == "estructurar_macrociclo":
                    resultado = estructurar_macrociclo(
                        objetivo=args.get("objetivo"),
                        fecha_meta=args.get("fecha_meta"),
                        resumen_estrategico=args.get("resumen_estrategico"),
                        fases=args.get("bloques") or args.get("fases") or [],
                        prioridad=args.get("prioridad", "A"),
                        tipo_evento=args.get("tipo_evento"),
                        disponibilidad_semanal=args.get("disponibilidad_semanal")
                    )
                elif func_name == "actualizar_calendario":
                    resultado = actualizar_calendario(
                        objetivo=args.get("objetivo"),
                        fecha_meta=args.get("fecha_meta"),
                        disponibilidad_semanal=args.get("disponibilidad_semanal"),
                        sesiones=args.get("sesiones", [])
                    )
                else:
                    resultado = {"aviso": "Consulta leída de memoria."}

                mensajes.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "name": func_name,
                    "content": json.dumps(resultado, ensure_ascii=False)
                })
                herramienta_ejecutada = True

        return {"respuesta": "He actualizado tu estructura de entrenamiento en la Agenda."}
    except Exception as e:
        return {"error_interno": f"Fallo en la matriz: {str(e)}"}


@app.get("/stats")
def obtener_estadisticas_dashboard(db: Session = Depends(get_db)):
    try:
        telemetria = obtener_telemetria_intervals_en_vivo(db)
        ftp = telemetria["ftp"]
        peso = telemetria["peso"]
        niveles = calcular_niveles_progresion(db, ftp)

        fecha_limite = datetime.now() - timedelta(days=30)
        historial = db.query(models.Activity).filter(
            models.Activity.icu_ctl.isnot(None),
            models.Activity.start_date_local >= fecha_limite
        ).order_by(models.Activity.start_date_local.asc()).all()

        if not historial:
            ultima_act = db.query(models.Activity).filter(
                models.Activity.icu_ctl.isnot(None)
            ).order_by(models.Activity.start_date_local.desc()).first()
            if not ultima_act:
                return {"error": "No hay suficientes datos. Sincroniza con Intervals.icu primero."}
            historial = [ultima_act]

        ultima_act = historial[-1]
        ctl = round(ultima_act.icu_ctl, 1)
        atl = round(ultima_act.icu_atl, 1)
        tsb = round(ctl - atl, 1)

        grafica_ctl = [{"value": round(act.icu_ctl, 1), "label": act.start_date_local.strftime("%d/%m")} for act in historial]
        grafica_atl = [{"value": round(act.icu_atl, 1), "label": act.start_date_local.strftime("%d/%m")} for act in historial]

        prompt = (
            f"El ciclista tiene CTL: {ctl}, ATL: {atl}, TSB: {tsb}, FTP: {ftp}W, peso: {peso}kg ({telemetria['wkg']} W/kg). "
            f"Sus niveles de progresión actuales son Z2={niveles['resistencia_z2']}/10, SweetSpot={niveles['sweet_spot']}/10, VO2max={niveles['vo2max']}/10, Durabilidad={niveles['durabilidad_kj']}/10. "
            "Escribe un diagnóstico fisiológico directo y claro (2 párrafos) sobre su estado de forma, fortalezas/limitantes y recomendaciones de carga. Sin saludos."
        )

        response = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1000
        )

        return {
            "fitness_ctl": ctl,
            "fatiga_atl": atl,
            "frescura_tsb": tsb,
            "ftp_actual": ftp,
            "peso_actual": peso,
            "wkg_actual": telemetria["wkg"],
            "lthr_actual": telemetria["lthr"],
            "max_hr_actual": telemetria["max_hr"],
            "hrv_actual": telemetria.get("hrv"),
            "sleep_hours": telemetria.get("sleep_hours"),
            "resting_hr": telemetria.get("resting_hr"),
            "niveles_progresion": niveles,
            "explicacion_ia": response.choices[0].message.content,
            "grafica_ctl": grafica_ctl,
            "grafica_atl": grafica_atl
        }
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/exportar/nube/{sesion_id}")
async def exportar_a_nube(sesion_id: int, db: Session = Depends(get_db)):
    try:
        sesion = db.query(models.EntrenamientoProgramado).filter(models.EntrenamientoProgramado.id == sesion_id).first()
        if not sesion:
            return {"error": "Sesión no encontrada"}

        estructura = cargar_estructura(sesion.estructura)
        if not estructura and sesion.duracion_minutos_planeada > 0:
            estructura = generar_estructura_respaldo(sesion.tipo_sesion, sesion.duracion_minutos_planeada)

        if estructura:
            workout_text = estructura_a_texto_intervals(estructura)
        else:
            prompt = f"""
            Convierte esta sesión en formato de texto estricto para Intervals.icu.
            Sesión: '{sesion.tipo_sesion}' ({sesion.duracion_minutos_planeada} min)
            Reglas:
            - Usa 'm' para minutos y '%' para porcentaje de FTP.
            - Ejemplo: "4x 4m 105%, 4m 50%"
            Devuelve ÚNICAMENTE las líneas de los intervalos. Nada de saludos ni comillas.
            """
            respuesta_ia = client.chat.completions.create(
                model="openai/gpt-oss-20b",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=500
            )
            workout_text = respuesta_ia.choices[0].message.content.strip()
            if workout_text.startswith("```"):
                lineas = workout_text.split("\n")
                workout_text = "\n".join(lineas[1:-1]).strip()

        obj = db.query(models.Objetivo).filter(models.Objetivo.id == sesion.objetivo_id).first()
        nombre_objetivo = obj.nombre if obj else "tu objetivo"

        payload = {
            "start_date_local": f"{sesion.fecha_programada}T00:00:00",
            "type": "Ride",
            "category": "WORKOUT",
            "name": f"AI Coach: {sesion.tipo_sesion[:24]}",
            "description": f"Sesión generada por VeloCoach Pro para {nombre_objetivo}.\n\n{workout_text}",
            "indoor": True if "indoor" in (sesion.entorno or "").lower() else False
        }

        url = f"{BASE_URL}/{ATHLETE_ID}/events"
        auth = ("API_KEY", API_KEY)

        async with httpx.AsyncClient() as client_http:
            response = await client_http.post(url, json=payload, auth=auth)

        if response.status_code == 200:
            return {"status": "success"}
        else:
            return {"error": f"Error {response.status_code}: {response.text}"}

    except Exception as e:
        return {"error": str(e)}


@app.get("/api/exportar/archivo/{sesion_id}")
async def exportar_archivo_fit(sesion_id: int, db: Session = Depends(get_db)):
    try:
        sesion = db.query(models.EntrenamientoProgramado).filter(models.EntrenamientoProgramado.id == sesion_id).first()
        if not sesion:
            return {"error": "Sesión no encontrada"}

        estructura = cargar_estructura(sesion.estructura)
        if not estructura and sesion.duracion_minutos_planeada > 0:
            estructura = generar_estructura_respaldo(sesion.tipo_sesion, sesion.duracion_minutos_planeada)

        if estructura:
            workout_text = estructura_a_texto_intervals(estructura)
        else:
            prompt = f"Convierte esta sesión para Intervals. Sesión: '{sesion.tipo_sesion}'. Reglas: Usa 'm' y '%'. Devuelve ÚNICAMENTE las líneas."
            respuesta_ia = client.chat.completions.create(model="openai/gpt-oss-20b", messages=[{"role": "user", "content": prompt}], max_tokens=500)
            workout_text = respuesta_ia.choices[0].message.content.strip()
            if workout_text.startswith("```"):
                workout_text = "\n".join(workout_text.split("\n")[1:-1]).strip()

        payload = {
            "start_date_local": f"{sesion.fecha_programada}T00:00:00",
            "type": "Ride",
            "category": "WORKOUT",
            "name": f"AI Coach: {sesion.tipo_sesion[:24]}",
            "description": workout_text
        }
        url_events = f"{BASE_URL}/{ATHLETE_ID}/events"
        auth = ("API_KEY", API_KEY)

        async with httpx.AsyncClient() as client_http:
            resp_post = await client_http.post(url_events, json=payload, auth=auth)
            if resp_post.status_code != 200:
                return {"error": "Fallo en la compilación"}

            evento_id = resp_post.json().get("id")
            url_fit = f"{BASE_URL}/{ATHLETE_ID}/events/{evento_id}/download.fit"
            resp_fit = await client_http.get(url_fit, auth=auth)

            return Response(
                content=resp_fit.content,
                media_type="application/vnd.ant.fit",
                headers={"Content-Disposition": f'attachment; filename="{sesion.tipo_sesion[:10]}.fit"'}
            )
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/calendario")
def get_calendario(db: Session = Depends(get_db)):
    try:
        hoy = datetime.now().date()
        telemetria = obtener_telemetria_intervals_en_vivo(db)
        usuario = db.query(models.Usuario).filter(models.Usuario.id == 1).first()

        objetivos = db.query(models.Objetivo).filter(
            models.Objetivo.usuario_id == 1,
            models.Objetivo.activo == True
        ).order_by(models.Objetivo.prioridad.asc(), models.Objetivo.fecha_meta.asc()).all()

        obj = objetivos[0] if objetivos else None

        fases_db = []
        if obj and hasattr(models, "FaseMacrociclo"):
            try:
                fases_db = db.query(models.FaseMacrociclo).filter(
                    models.FaseMacrociclo.usuario_id == 1,
                    models.FaseMacrociclo.objetivo_id == obj.id
                ).order_by(models.FaseMacrociclo.orden.asc()).all()
            except Exception:
                fases_db = []

        fases_formateadas = []
        fase_activa_info = None
        resumen_estrategico = None

        for idx, f in enumerate(fases_db):
            if idx == 0 and f.resumen_estrategico:
                resumen_estrategico = f.resumen_estrategico

            dias_totales = max(1, (f.fecha_fin - f.fecha_inicio).days + 1)
            if hoy < f.fecha_inicio:
                estado_fase = "pendiente"
                dias_restantes = (f.fecha_fin - f.fecha_inicio).days + 1
                progreso = 0
            elif hoy > f.fecha_fin:
                estado_fase = "completada"
                dias_restantes = 0
                progreso = 100
            else:
                estado_fase = "activa"
                dias_restantes = (f.fecha_fin - hoy).days + 1
                dias_transcurridos = (hoy - f.fecha_inicio).days + 1
                progreso = min(100, max(5, int((dias_transcurridos / dias_totales) * 100)))

            item_fase = {
                "id": f.id,
                "orden": f.orden,
                "nombre": f.nombre,
                "fecha_inicio": f.fecha_inicio.strftime("%Y-%m-%d"),
                "fecha_fin": f.fecha_fin.strftime("%Y-%m-%d"),
                "descripcion": f.descripcion,
                "foco": f.foco_fisiologico,
                "estado": estado_fase,
                "dias_restantes": dias_restantes,
                "progreso": progreso
            }
            fases_formateadas.append(item_fase)
            if estado_fase == "activa":
                fase_activa_info = item_fase

        if not fase_activa_info and fases_formateadas:
            fase_activa_info = fases_formateadas[0]

        sesiones = db.query(models.EntrenamientoProgramado).filter(
            models.EntrenamientoProgramado.usuario_id == 1,
            models.EntrenamientoProgramado.fecha_programada >= hoy
        ).order_by(models.EntrenamientoProgramado.fecha_programada.asc()).limit(14).all()

        nombre_obj = obj.nombre if obj else "Configura tu Objetivo"
        fecha_obj = obj.fecha_meta.strftime("%Y-%m-%d") if (obj and obj.fecha_meta) else None
        disp_actual = (
            (usuario.disponibilidad_json if usuario and usuario.disponibilidad_json else None)
            or (obj.disponibilidad_semanal if obj else None)
        )

        return {
            "telemetria": {
                "ftp": telemetria["ftp"],
                "peso": telemetria["peso"],
                "lthr": telemetria["lthr"],
                "max_hr": telemetria["max_hr"],
                "hrv": telemetria.get("hrv"),
                "resting_hr": telemetria.get("resting_hr"),
                "sleep_hours": telemetria.get("sleep_hours"),
                "objetivo": nombre_obj,
                "fecha_meta": fecha_obj
            },
            "macrociclo": {
                "objetivo": nombre_obj,
                "fecha_meta": fecha_obj,
                "disponibilidad": disp_actual,
                "objetivos_temporada": [
                    {
                        "id": o.id,
                        "nombre": o.nombre,
                        "fecha_meta": o.fecha_meta.strftime("%Y-%m-%d") if o.fecha_meta else None,
                        "prioridad": o.prioridad or "A",
                        "tipo_evento": o.tipo_evento
                    } for o in objetivos
                ],
                "total_fases": len(fases_formateadas),
                "resumen_estrategico": resumen_estrategico,
                "fase_activa": fase_activa_info,
                "fases": fases_formateadas
            },
            "sesiones": [
                {
                    "id": s.id,
                    "fecha": s.fecha_programada.strftime("%Y-%m-%d"),
                    "sesion": s.tipo_sesion,
                    "entorno": s.entorno,
                    "duracion": s.duracion_minutos_planeada,
                    "tss": s.tss_planeado,
                    "tss_real": getattr(s, "tss_real", None),
                    "estado": s.estado,
                    "nota": s.motivo_adaptacion,
                    "estructura": cargar_estructura(getattr(s, "estructura", None))
                } for s in sesiones
            ]
        }
    except Exception as e:
        print(f"Error protegido en get_calendario: {e}")
        return {
            "telemetria": {"ftp": 305, "peso": 71.0, "lthr": 178, "max_hr": 200, "objetivo": "Configura tu Objetivo", "fecha_meta": None},
            "macrociclo": {"objetivo": "Configura tu Objetivo", "fecha_meta": None, "total_fases": 0, "resumen_estrategico": None, "fase_activa": None, "fases": []},
            "sesiones": []
        }


@app.post("/api/calendario/toggle/{sesion_id}")
def toggle_estado_sesion(sesion_id: int, db: Session = Depends(get_db)):
    sesion = db.query(models.EntrenamientoProgramado).filter(
        models.EntrenamientoProgramado.id == sesion_id
    ).first()
    if not sesion:
        return {"error": "Sesión no encontrada"}

    sesion.estado = "Completado" if sesion.estado != "Completado" else "Pendiente"
    db.commit()
    return {"status": "success", "nuevo_estado": sesion.estado}