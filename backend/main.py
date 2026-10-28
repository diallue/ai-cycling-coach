from fastapi import FastAPI, Depends, Response, Header, Query, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import os
import re
import json
import hashlib
import secrets
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

app = FastAPI(title="AI Cycling Coach Multi-User & OAuth2 API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

models.Base.metadata.create_all(bind=engine)


def asegurar_columnas_nuevas():
    migraciones = [
        "ALTER TABLE entrenamientos_programados ADD COLUMN IF NOT EXISTS estructura TEXT",
        "ALTER TABLE entrenamientos_programados ADD COLUMN IF NOT EXISTS tss_real INTEGER",
        "ALTER TABLE entrenamientos_programados ADD COLUMN IF NOT EXISTS actividad_completada_id VARCHAR",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS peso_actual FLOAT DEFAULT 71.0",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS lthr INTEGER DEFAULT 178",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS max_hr INTEGER DEFAULT 200",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS w_prime INTEGER",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS disponibilidad_json TEXT",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash VARCHAR",
        "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_sesion VARCHAR",
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


def sincronizar_secuencias():
    """Resincroniza las secuencias auto-incrementales de PostgreSQL con el MAX(id) real."""
    tablas = ["usuarios", "objetivos", "entrenamientos_programados", "fases_macrociclo"]
    for tabla in tablas:
        try:
            with engine.begin() as conn:
                conn.execute(text(f"""
                    SELECT setval(
                        pg_get_serial_sequence('{tabla}', 'id'),
                        COALESCE((SELECT MAX(id) FROM {tabla}), 1),
                        true
                    );
                """))
        except Exception:
            pass


asegurar_columnas_nuevas()
sincronizar_secuencias()

client = Groq(api_key=os.getenv("GROQ_API_KEY"))

DEFAULT_ATHLETE_ID = os.getenv("INTERVALS_ATHLETE_ID")
DEFAULT_API_KEY = os.getenv("INTERVALS_API_KEY")
INTERVALS_CLIENT_ID = os.getenv("INTERVALS_CLIENT_ID", "")
INTERVALS_CLIENT_SECRET = os.getenv("INTERVALS_CLIENT_SECRET", "")
BACKEND_PUBLIC_URL = os.getenv("BACKEND_PUBLIC_URL", "https://ai-cycling-coach-822a.onrender.com")
BASE_URL = "https://intervals.icu/api/v1/athlete"

# Caché en memoria indexado por usuario_id y estados pendientes de OAuth2
_TELEMETRIA_CACHE: Dict[int, dict] = {}
_OAUTH_PENDING_STATES: Dict[str, dict] = {}


def hash_password(password: str) -> str:
    salt = "velocoach_pro_salt_2026"
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100000).hex()


def serializar_usuario(u: models.Usuario) -> dict:
    ath_id = u.intervals_athlete_id or (DEFAULT_ATHLETE_ID if u.id == 1 else "")
    has_key = bool(u.intervals_api_key or (DEFAULT_API_KEY if u.id == 1 else None))
    return {
        "id": u.id,
        "email": u.email,
        "nombre": u.nombre,
        "ftp_actual": u.ftp_actual or 250,
        "peso_actual": u.peso_actual or 70.0,
        "lthr": u.lthr or 175,
        "max_hr": u.max_hr or 195,
        "intervals_athlete_id": ath_id or "",
        "intervals_conectado": bool(ath_id and has_key),
        "disponibilidad": u.disponibilidad_json,
    }


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
                password_hash=hash_password("123456"),
                token_sesion="token_diego_inicial",
                intervals_athlete_id=DEFAULT_ATHLETE_ID,
                intervals_api_key=DEFAULT_API_KEY,
                ftp_actual=305,
                peso_actual=71.0,
                lthr=178,
                max_hr=200
            )
            db.add(nuevo_usuario)
            db.commit()
        else:
            if not usuario_principal.password_hash:
                usuario_principal.password_hash = hash_password("123456")
            if not usuario_principal.intervals_athlete_id and DEFAULT_ATHLETE_ID:
                usuario_principal.intervals_athlete_id = DEFAULT_ATHLETE_ID
            if not usuario_principal.intervals_api_key and DEFAULT_API_KEY:
                usuario_principal.intervals_api_key = DEFAULT_API_KEY
            db.commit()
        sincronizar_secuencias()
    except Exception as e:
        print(f"Nota sobre el usuario inicial: {e}")
    finally:
        db.close()


def obtener_usuario_actual(
    authorization: Optional[str] = Header(None),
    token_query: Optional[str] = Query(None, alias="token"),
    db: Session = Depends(get_db)
) -> models.Usuario:
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.replace("Bearer ", "").strip()
    elif token_query:
        token = token_query.strip()

    if token:
        usuario = db.query(models.Usuario).filter(models.Usuario.token_sesion == token).first()
        if usuario:
            return usuario
        raise HTTPException(status_code=401, detail="Sesión expirada o inválida. Vuelve a iniciar sesión.")

    usuario_defecto = db.query(models.Usuario).filter(models.Usuario.id == 1).first()
    return usuario_defecto


class RegistroPayload(BaseModel):
    nombre: str
    email: str
    password: str
    ftp_actual: Optional[int] = 250
    peso_actual: Optional[float] = 70.0
    lthr: Optional[int] = 175
    max_hr: Optional[int] = 195
    intervals_athlete_id: Optional[str] = None
    intervals_api_key: Optional[str] = None


class LoginPayload(BaseModel):
    email: str
    password: str


class ActualizarPerfilPayload(BaseModel):
    nombre: Optional[str] = None
    ftp_actual: Optional[int] = None
    peso_actual: Optional[float] = None
    lthr: Optional[int] = None
    max_hr: Optional[int] = None
    intervals_athlete_id: Optional[str] = None
    intervals_api_key: Optional[str] = None


class MensajeHistorial(BaseModel):
    rol: str
    texto: str


class MensajeChat(BaseModel):
    texto: str
    historial: Optional[List[MensajeHistorial]] = []


class CheckinDiarioPayload(BaseModel):
    fecha: Optional[str] = None
    sensacion_piernas: str = "normales"
    minutos_disponibles: int = 90
    entorno: str = "Indoor"
    notas: Optional[str] = None


class DisponibilidadPayload(BaseModel):
    horas_por_dia: Dict[str, float]


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


def credenciales_intervals(usuario: models.Usuario):
    """Devuelve (athlete_id, httpx_kwargs) soportando tanto OAuth2 Bearer como API_KEY clásica."""
    ath_id = (usuario.intervals_athlete_id or "").strip()
    api_k = (usuario.intervals_api_key or "").strip()
    if not ath_id and usuario.id == 1:
        ath_id = DEFAULT_ATHLETE_ID or ""
    if not api_k and usuario.id == 1:
        api_k = DEFAULT_API_KEY or ""

    if not ath_id or not api_k:
        return "", {}

    if api_k.startswith("BEARER:"):
        token_oauth = api_k.replace("BEARER:", "", 1).strip()
        return ath_id, {"headers": {"Authorization": f"Bearer {token_oauth}"}}

    return ath_id, {"auth": ("API_KEY", api_k)}


def obtener_telemetria_intervals_en_vivo(db: Session, usuario: models.Usuario, forzar: bool = False):
    ahora = datetime.now()
    uid = usuario.id
    cache_usr = _TELEMETRIA_CACHE.get(uid)
    if (
        not forzar
        and cache_usr
        and cache_usr.get("data") is not None
        and cache_usr.get("timestamp") is not None
        and (ahora - cache_usr["timestamp"]).total_seconds() < 300
    ):
        return cache_usr["data"]

    act_con_ftp = db.query(models.Activity).filter(
        models.Activity.usuario_id == uid,
        models.Activity.icu_ftp.isnot(None)
    ).order_by(models.Activity.start_date_local.desc()).first()

    ftp = (usuario.ftp_actual if usuario.ftp_actual else None) or (act_con_ftp.icu_ftp if act_con_ftp else 250)
    peso = (usuario.peso_actual if usuario.peso_actual else 70.0)
    lthr = (usuario.lthr if usuario.lthr else 175)
    max_hr = (usuario.max_hr if usuario.max_hr else 195)
    w_prime = usuario.w_prime
    hrv_rmssd = None
    resting_hr = None
    sleep_hours = None
    peso_api = None
    ctl_live = round(act_con_ftp.icu_ctl, 1) if (act_con_ftp and act_con_ftp.icu_ctl) else 0.0
    atl_live = round(act_con_ftp.icu_atl, 1) if (act_con_ftp and act_con_ftp.icu_atl) else 0.0

    ath_id, auth_kwargs = credenciales_intervals(usuario)

    if ath_id and auth_kwargs:
        try:
            with httpx.Client(timeout=4.5) as client_http:
                resp_ath = client_http.get(f"{BASE_URL}/{ath_id}", **auth_kwargs)
                if resp_ath.status_code == 200:
                    data = resp_ath.json()
                    if data.get("name") and (not usuario.nombre or usuario.nombre.startswith("Ciclista")):
                        usuario.nombre = data["name"]
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
                    f"{BASE_URL}/{ath_id}/wellness",
                    params={"oldest": oldest_w, "newest": newest_w},
                    **auth_kwargs
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

            usuario.ftp_actual = ftp
            usuario.peso_actual = peso
            usuario.lthr = lthr
            usuario.max_hr = max_hr
            if w_prime:
                usuario.w_prime = w_prime
            db.commit()
        except Exception as e:
            print(f"Aviso telemetría Intervals.icu usuario {uid}: {e}")

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
    _TELEMETRIA_CACHE[uid] = {"timestamp": ahora, "data": resultado}
    return resultado


def calcular_niveles_progresion(db: Session, usuario_id: int, ftp: int):
    hace_42d = datetime.now() - timedelta(days=42)
    acts = db.query(models.Activity).filter(
        models.Activity.usuario_id == usuario_id,
        models.Activity.start_date_local >= hace_42d
    ).all()

    if not acts:
        return {
            "resistencia_z2": 4.0,
            "tempo_torque": 3.8,
            "sweet_spot": 4.2,
            "umbral_ftp": 3.8,
            "vo2max": 3.2,
            "durabilidad_kj": 3.9,
            "distribucion": {"z1_z2_pct": 78, "z3_z4_pct": 16, "z5_pct": 6, "modelo": "Piramidal Base"}
        }

    horas_totales = sum(((a.moving_time or 0) / 3600.0) for a in acts)
    horas_sem = horas_totales / 6.0
    max_horas = max(((a.moving_time or 0) / 3600.0) for a in acts)
    desnivel_medio_salida = sum((a.total_elevation_gain or 0) for a in acts) / max(1, len(acts))

    salidas_ss = 0
    salidas_umbral = 0
    salidas_vo2 = 0
    salidas_2000kj = 0
    tiempo_baja = 0.0
    tiempo_media = 0.0
    tiempo_alta = 0.0

    for a in acts:
        dur_h = (a.moving_time or 0) / 3600.0
        np_act = a.normalized_power or (ftp * 0.66)
        if_act = np_act / max(150, ftp)
        kj_act = (np_act * (a.moving_time or 0)) / 1000.0
        if kj_act >= 2000:
            salidas_2000kj += 1

        if if_act < 0.76:
            tiempo_baja += dur_h
        elif if_act <= 0.94:
            tiempo_media += dur_h
            salidas_ss += 1
        elif if_act <= 1.03:
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

    lvl_z2 = round(min(9.5, max(2.5, 3.2 + (horas_sem * 0.42) + min(2.2, max_horas * 0.35))), 1)
    lvl_torque = round(min(9.4, max(2.5, 3.0 + (desnivel_medio_salida / 420.0) * 1.4 + min(2.0, salidas_ss * 0.25))), 1)
    lvl_ss = round(min(9.4, max(2.5, 3.4 + min(4.8, salidas_ss * 0.55))), 1)
    lvl_ftp = round(min(9.2, max(2.4, 3.0 + min(4.5, salidas_umbral * 0.85) + min(1.5, salidas_ss * 0.18))), 1)
    lvl_vo2 = round(min(9.2, max(2.2, 2.8 + min(5.2, salidas_vo2 * 0.95) + (z5_pct * 0.12))), 1)
    lvl_durabilidad = round(min(9.5, max(2.5, 3.5 + min(4.2, salidas_2000kj * 0.65) + min(1.5, max_horas * 0.25))), 1)

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
    dur = int(duracion_total or 0)
    if dur <= 0 or "descanso" in (tipo_sesion or "").lower():
        return None

    texto = (tipo_sesion or "").lower()
    cal = max(10, round(dur * 0.15))
    enf = max(10, round(dur * 0.10))
    cuerpo = max(15, dur - cal - enf)

    if any(k in texto for k in ["30/15", "ronnestad", "rønnestad", "micro", "sprint"]):
        reps = 8 if "sprint" not in texto else 6
        trab_m = 0.5 if "sprint" not in texto else 0.25
        rec_m = 0.25 if "sprint" not in texto else 2.75
        pct_t = 120 if "sprint" not in texto else 135
        usado = round(reps * (trab_m + rec_m))
        resto_z2 = max(10, cuerpo - usado)
        return [
            {"tipo": "continuo", "etiqueta": "Calentamiento progresivo", "duracion_min": cal, "ftp_pct": 60, "cadencia": "90 rpm"},
            {"tipo": "continuo", "etiqueta": "Base aeróbica Z2", "duracion_min": resto_z2, "ftp_pct": 68, "cadencia": "90-95 rpm"},
            {"tipo": "intervalos", "etiqueta": "Activaciones Neuromusculares / Cadencia" if "sprint" in texto else "Rønnestad 30/15s VO2max", "repeticiones": reps, "trabajo_min": trab_m, "trabajo_ftp_pct": pct_t, "trabajo_cadencia": "105-110 rpm", "recuperacion_min": rec_m, "recuperacion_ftp_pct": 55},
            {"tipo": "continuo", "etiqueta": "Enfriamiento Z1", "duracion_min": max(5, dur - (cal + usado + resto_z2)), "ftp_pct": 50, "cadencia": "85 rpm"},
        ]

    if any(k in texto for k in ["cadencia", "drill"]):
        reps = 5 if cuerpo >= 50 else 4
        usado = reps * 8
        resto_z2 = max(10, cuerpo - usado)
        return [
            {"tipo": "continuo", "etiqueta": "Calentamiento progresivo", "duracion_min": cal, "ftp_pct": 58, "cadencia": "90 rpm"},
            {"tipo": "intervalos", "etiqueta": "Drills Eficiencia Cadencia Alta", "repeticiones": reps, "trabajo_min": 5, "trabajo_ftp_pct": 72, "trabajo_cadencia": "100-105 rpm", "recuperacion_min": 3, "recuperacion_ftp_pct": 62},
            {"tipo": "continuo", "etiqueta": "Rodaje Z2 aeróbico", "duracion_min": resto_z2, "ftp_pct": 68, "cadencia": "90 rpm"},
            {"tipo": "continuo", "etiqueta": "Enfriamiento suave", "duracion_min": max(5, dur - (cal + usado + resto_z2)), "ftp_pct": 50, "cadencia": "85 rpm"},
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

    if any(k in texto for k in ["sweet", "ss", "umbral", "ftp", "fuerza", "torque", "tempo", "progresivo", "surge", "z3"]):
        es_torque = "fuerza" in texto or "torque" in texto or "baja cadencia" in texto
        pct_trab = 85 if es_torque else (83 if "z3" in texto or "progresivo" in texto else 91)
        cad_trab = "60-65 rpm" if es_torque else "88-92 rpm"
        reps = 4 if es_torque else (3 if cuerpo >= 50 else 2)
        trab_min = 8 if es_torque else min(16, max(10, (cuerpo // reps) - 5))
        rec_min = 4
        usado = reps * (trab_min + rec_min)
        resto_z2 = max(0, cuerpo - usado)
        bloques = [
            {"tipo": "continuo", "etiqueta": "Calentamiento progresivo", "duracion_min": cal, "ftp_pct": 60, "cadencia": "90 rpm"},
        ]
        if resto_z2 >= 15:
            bloques.append({"tipo": "continuo", "etiqueta": "Base aeróbica Z2", "duracion_min": resto_z2, "ftp_pct": 68, "cadencia": "90 rpm"})
            enf_real = dur - (cal + usado + resto_z2)
        else:
            enf_real = dur - (cal + usado)
        bloques.append({
            "tipo": "intervalos",
            "etiqueta": "Fuerza-Resistencia Torque" if es_torque else ("Bloques Tempo Z3" if pct_trab < 88 else "Sweet Spot Progresivo"),
            "repeticiones": reps,
            "trabajo_min": trab_min,
            "trabajo_ftp_pct": pct_trab,
            "trabajo_cadencia": cad_trab,
            "recuperacion_min": rec_min,
            "recuperacion_ftp_pct": 55,
        })
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
    dur_total_int = int(duracion_total or 0)
    if dur_total_int <= 0:
        return None
    return generar_estructura_respaldo(tipo_sesion, dur_total_int)


def cargar_estructura(texto):
    if not texto:
        return None
    try:
        datos = json.loads(texto)
    except (ValueError, TypeError):
        return None
    return datos if isinstance(datos, list) and datos else None


def estructura_a_texto_intervals(estructura):
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
    if "failed_generation" not in error_str and '"sesiones"' not in error_str:
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


def formatear_respuesta_semanal_markdown(guardado: list, ftp: int) -> str:
    filas = []
    desglose = []
    for s in guardado:
        dia_cap = s["dia"].capitalize()
        dur_h = f"{s['duracion_min'] // 60}h {s['duracion_min'] % 60:02d}m" if s["duracion_min"] >= 60 else f"{s['duracion_min']}m"
        filas.append(f"| **{dia_cap}** ({s['fecha'][5:]}) | {s['entorno']} | {dur_h} | {s['sesion']} | {s['tss']} |")

        pasos_txt = []
        for b in s.get("bloques", []):
            if b.get("tipo") == "intervalos":
                w_trab = round(ftp * (b["trabajo_ftp_pct"] / 100.0))
                w_rec = round(ftp * (b["recuperacion_ftp_pct"] / 100.0))
                pasos_txt.append(
                    f"{b['repeticiones']}x {b['trabajo_min']}m a ~{w_trab}W ({b['trabajo_ftp_pct']}% FTP, {b.get('trabajo_cadencia', '90 rpm')}) / rec {b['recuperacion_min']}m a {w_rec}W"
                )
            else:
                w_cont = round(ftp * (b["ftp_pct"] / 100.0))
                pasos_txt.append(f"{b['etiqueta']}: {b['duracion_min']}m a ~{w_cont}W ({b['ftp_pct']}% FTP, {b.get('cadencia', '90 rpm')})")
        detalle_bloques = " → ".join(pasos_txt) if pasos_txt else "Descanso pasivo y supercompensación."
        desglose.append(f"* **{dia_cap} — {s['sesion']} ({s['tss']} TSS):** {detalle_bloques}")

    return (
        "### 🗓 Planificación Semanal\n\n"
        "| Día | Entorno | Duración | Sesión | TSS |\n"
        "| :--- | :--- | :--- | :--- | :--- |\n"
        + "\n".join(filas)
        + f"\n\n### 🔬 Análisis Fisiológico y Ejecución (FTP {ftp}W)\n\n"
        + "\n".join(desglose)
        + "\n\n### 💡 Pro-Tips del Coach\n"
        "* **Nutrición intra-entreno:** En sesiones de 90-120 min apunta a **60 g CHO/h**; en tiradas de 3h sube a **80-90 g CHO/h**.\n"
        "* **Control de deriva cardíaca:** Mantén una cadencia fluida (90-95 rpm en Z2 y 60-65 rpm en bloques específicos de fuerza/torque)."
    )


# ============================================================================
# ENDPOINTS OAUTH2 OFICIAL DE INTERVALS.ICU + GESTIÓN DE CUENTA
# ============================================================================
@app.get("/api/auth/intervals/login-url")
def obtener_url_oauth_intervals():
    """Genera la URL de autorización OAuth2 hacia Intervals.icu y un state para la app móvil."""
    state = secrets.token_urlsafe(24)
    _OAUTH_PENDING_STATES[state] = {"status": "pending", "created_at": datetime.now()}

    if not INTERVALS_CLIENT_ID:
        return {
            "oauth_configurado": False,
            "state": state,
            "mensaje": "Falta configurar INTERVALS_CLIENT_ID en las variables de entorno de Render.",
            "registro_intervals_url": "https://intervals.icu/"
        }

    redirect_uri = f"{BACKEND_PUBLIC_URL}/api/auth/intervals/callback"
    scope = "ACTIVITY:READ,WELLNESS:READ,CALENDAR:WRITE,SETTINGS:READ"
    authorize_url = (
        f"https://intervals.icu/oauth/authorize"
        f"?client_id={INTERVALS_CLIENT_ID}"
        f"&redirect_uri={redirect_uri}"
        f"&scope={scope}"
        f"&state={state}"
    )
    return {
        "oauth_configurado": True,
        "state": state,
        "authorize_url": authorize_url,
        "registro_intervals_url": "https://intervals.icu/"
    }


@app.get("/api/auth/intervals/callback", response_class=HTMLResponse)
def oauth_intervals_callback(
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Recibe la confirmación de Intervals.icu, canjea el access_token y vincula/crea al ciclista."""
    if error or not code:
        if state and state in _OAUTH_PENDING_STATES:
            _OAUTH_PENDING_STATES[state] = {"status": "error", "detail": error or "Cancelado"}
        return """
        <html><body style="background:#020617;color:#f8fafc;font-family:sans-serif;text-align:center;padding:50px;">
            <h2 style="color:#f43f5e;">Autorización cancelada</h2>
            <p>Puedes cerrar esta ventana y volver a VeloCoach Pro.</p>
        </body></html>
        """

    try:
        with httpx.Client(timeout=10.0) as client_http:
            resp = client_http.post(
                "https://intervals.icu/api/oauth/token",
                data={
                    "client_id": INTERVALS_CLIENT_ID,
                    "client_secret": INTERVALS_CLIENT_SECRET,
                    "code": code,
                }
            )

        if resp.status_code != 200:
            raise Exception(f"Fallo canjeando token OAuth: {resp.text}")

        token_data = resp.json()
        access_token = token_data.get("access_token")
        athlete_info = token_data.get("athlete") or {}
        athlete_id = str(athlete_info.get("id") or "").strip()
        athlete_name = athlete_info.get("name") or "Ciclista Intervals"
        athlete_email = (athlete_info.get("email") or f"{athlete_id}@intervals.icu").lower()

        if not access_token or not athlete_id:
            raise Exception("Intervals.icu no devolvió athlete_id o access_token.")

        usuario = db.query(models.Usuario).filter(
            models.Usuario.intervals_athlete_id == athlete_id
        ).first()

        if not usuario:
            usuario = db.query(models.Usuario).filter(
                models.Usuario.email == athlete_email
            ).first()

        sincronizar_secuencias()
        token_sesion = secrets.token_urlsafe(32)

        if not usuario:
            usuario = models.Usuario(
                email=athlete_email,
                nombre=athlete_name,
                intervals_athlete_id=athlete_id,
                intervals_api_key=f"BEARER:{access_token}",
                token_sesion=token_sesion,
                ftp_actual=250,
                peso_actual=70.0,
                lthr=175,
                max_hr=195,
            )
            db.add(usuario)
        else:
            usuario.nombre = athlete_name or usuario.nombre
            usuario.intervals_athlete_id = athlete_id
            usuario.intervals_api_key = f"BEARER:{access_token}"
            usuario.token_sesion = token_sesion

        db.commit()
        db.refresh(usuario)

        obtener_telemetria_intervals_en_vivo(db, usuario, forzar=True)

        if state:
            _OAUTH_PENDING_STATES[state] = {
                "status": "completed",
                "token": token_sesion,
                "usuario": serializar_usuario(usuario),
                "created_at": datetime.now()
            }

        return f"""
        <html><body style="background:#020617;color:#f8fafc;font-family:sans-serif;text-align:center;padding:50px;">
            <div style="max-width:400px;margin:0 auto;background:#0f172a;padding:30px;border-radius:20px;border:1px solid #10b981;">
                <div style="font-size:42px;">🚴‍♂️✅</div>
                <h2 style="color:#10b981;">¡Hola, {usuario.nombre}!</h2>
                <p style="color:#cbd5e1;line-height:1.5;">Tu cuenta de <b>Intervals.icu ({athlete_id})</b> se ha vinculado automáticamente con VeloCoach IA.</p>
                <p style="color:#38bdf8;font-weight:bold;margin-top:20px;">Ya puedes volver a la aplicación.</p>
            </div>
        </body></html>
        """
    except Exception as e:
        if state:
            _OAUTH_PENDING_STATES[state] = {"status": "error", "detail": str(e)}
        return f"""
        <html><body style="background:#020617;color:#f8fafc;font-family:sans-serif;text-align:center;padding:50px;">
            <h2 style="color:#f43f5e;">Error al vincular con Intervals.icu</h2>
            <p>{str(e)}</p>
        </body></html>
        """


@app.get("/api/auth/intervals/poll/{state}")
def consultar_estado_oauth(state: str):
    """La app móvil consulta este endpoint cada 2s mientras el usuario autoriza en el navegador."""
    info = _OAUTH_PENDING_STATES.get(state)
    if not info:
        return {"status": "not_found"}
    if info.get("status") == "completed":
        datos = _OAUTH_PENDING_STATES.pop(state, info)
        return {
            "status": "completed",
            "token": datos["token"],
            "usuario": datos["usuario"]
        }
    return {"status": info.get("status", "pending"), "detail": info.get("detail")}


@app.post("/api/auth/register")
def registrar_usuario(payload: RegistroPayload, db: Session = Depends(get_db)):
    email_limpio = payload.email.strip().lower()
    if not email_limpio or not payload.password or len(payload.password) < 4:
        raise HTTPException(status_code=400, detail="Introduce un email válido y una contraseña de al menos 4 caracteres.")

    existente = db.query(models.Usuario).filter(models.Usuario.email == email_limpio).first()
    if existente:
        raise HTTPException(status_code=400, detail="Este email ya está registrado. Inicia sesión con tu cuenta.")

    token = secrets.token_urlsafe(32)
    nuevo = models.Usuario(
        email=email_limpio,
        nombre=payload.nombre.strip() or "Ciclista",
        password_hash=hash_password(payload.password),
        token_sesion=token,
        ftp_actual=payload.ftp_actual or 250,
        peso_actual=payload.peso_actual or 70.0,
        lthr=payload.lthr or 175,
        max_hr=payload.max_hr or 195,
        intervals_athlete_id=(payload.intervals_athlete_id or "").strip() or None,
        intervals_api_key=(payload.intervals_api_key or "").strip() or None,
    )
    try:
        db.add(nuevo)
        db.commit()
    except Exception:
        db.rollback()
        sincronizar_secuencias()
        try:
            db.add(nuevo)
            db.commit()
        except Exception as e2:
            db.rollback()
            raise HTTPException(status_code=400, detail=f"Error en el registro: {str(e2)}")

    db.refresh(nuevo)

    if nuevo.intervals_athlete_id and nuevo.intervals_api_key:
        obtener_telemetria_intervals_en_vivo(db, nuevo, forzar=True)

    return {"status": "success", "token": token, "usuario": serializar_usuario(nuevo)}


@app.post("/api/auth/login")
def login_usuario(payload: LoginPayload, db: Session = Depends(get_db)):
    email_limpio = payload.email.strip().lower()
    usuario = db.query(models.Usuario).filter(models.Usuario.email == email_limpio).first()
    if not usuario:
        raise HTTPException(status_code=401, detail="No existe ninguna cuenta con ese email.")

    hash_intento = hash_password(payload.password)
    if usuario.password_hash and usuario.password_hash != hash_intento:
        raise HTTPException(status_code=401, detail="Contraseña incorrecta.")

    if not usuario.password_hash:
        usuario.password_hash = hash_intento

    token = secrets.token_urlsafe(32)
    usuario.token_sesion = token
    db.commit()
    db.refresh(usuario)

    return {"status": "success", "token": token, "usuario": serializar_usuario(usuario)}


@app.get("/api/auth/me")
def obtener_perfil_actual(
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    return {"status": "success", "usuario": serializar_usuario(usuario)}


@app.put("/api/auth/perfil")
def actualizar_perfil_usuario(
    payload: ActualizarPerfilPayload,
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    if payload.nombre is not None and payload.nombre.strip():
        usuario.nombre = payload.nombre.strip()
    if payload.ftp_actual is not None and payload.ftp_actual > 50:
        usuario.ftp_actual = int(payload.ftp_actual)
    if payload.peso_actual is not None and payload.peso_actual > 30:
        usuario.peso_actual = float(payload.peso_actual)
    if payload.lthr is not None and payload.lthr > 80:
        usuario.lthr = int(payload.lthr)
    if payload.max_hr is not None and payload.max_hr > 100:
        usuario.max_hr = int(payload.max_hr)
    if payload.intervals_athlete_id is not None:
        usuario.intervals_athlete_id = payload.intervals_athlete_id.strip() or None
    if payload.intervals_api_key is not None and payload.intervals_api_key.strip():
        usuario.intervals_api_key = payload.intervals_api_key.strip()

    db.commit()
    db.refresh(usuario)
    obtener_telemetria_intervals_en_vivo(db, usuario, forzar=True)
    return {"status": "success", "usuario": serializar_usuario(usuario)}


@app.get("/")
def read_root():
    return {"status": "ok", "message": "Backend VeloCoach Pro Multi-User & OAuth2 activo"}


@app.post("/sync")
async def sync_activities(
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    ath_id, auth_kwargs = credenciales_intervals(usuario)
    if not ath_id or not auth_kwargs:
        return {"status": "no_credentials", "message": "Conecta tu cuenta con Intervals.icu primero."}

    oldest = "2022-01-01T00:00:00"
    newest = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    url = f"{BASE_URL}/{ath_id}/activities"
    params = {"oldest": oldest, "newest": newest}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client_http:
            response = await client_http.get(url, params=params, **auth_kwargs)

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

        raw_id = str(act.get("id"))
        act_pk = raw_id if usuario.id == 1 else f"u{usuario.id}_{raw_id}"

        existing_act = db.query(models.Activity).filter(models.Activity.id == act_pk).first()
        act_db = existing_act or models.Activity(id=act_pk, usuario_id=usuario.id)

        act_db.usuario_id = usuario.id
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
                models.EntrenamientoProgramado.usuario_id == usuario.id,
                models.EntrenamientoProgramado.fecha_programada == fecha_act
            ).first()
            if sesion_prog and sesion_prog.duracion_minutos_planeada > 0:
                sesion_prog.estado = "Completado"
                sesion_prog.tss_real = int(act_db.tss or 0)
                sesion_prog.actividad_completada_id = act_pk
                auto_completed_sessions += 1

    db.commit()
    obtener_telemetria_intervals_en_vivo(db, usuario, forzar=True)

    return {
        "status": "success",
        "inserted": inserted_count,
        "updated": updated_count,
        "auto_completed": auto_completed_sessions,
        "total_processed": len(activities_data)
    }


@app.post("/api/disponibilidad")
def guardar_disponibilidad_semanal(
    payload: DisponibilidadPayload,
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    orden = ["L", "M", "X", "J", "V", "S", "D"]
    partes = []
    total_h = 0.0
    for d in orden:
        h = round(float(payload.horas_por_dia.get(d, 0)), 1)
        total_h += h
        h_str = f"{int(h)}h" if h.is_integer() else f"{h}h"
        partes.append(f"{d}={h_str}")
    resumen_disp = f"{', '.join(partes)} (Máx: {round(total_h, 1)}h/sem)"

    usuario.disponibilidad_json = resumen_disp

    obj = db.query(models.Objetivo).filter(
        models.Objetivo.usuario_id == usuario.id,
        models.Objetivo.activo == True
    ).order_by(models.Objetivo.prioridad.asc()).first()
    if obj:
        obj.disponibilidad_semanal = resumen_disp

    db.commit()
    return {"status": "success", "disponibilidad": resumen_disp}


@app.post("/api/objetivos")
def crear_o_actualizar_objetivo(
    payload: NuevoObjetivoPayload,
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    try:
        sincronizar_secuencias()
        fecha_dt = datetime.strptime(payload.fecha_meta.strip(), "%Y-%m-%d").date()
        prio = (payload.prioridad or "B").upper()[:1]
        nuevo = models.Objetivo(
            usuario_id=usuario.id,
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
def eliminar_objetivo(
    objetivo_id: int,
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    obj = db.query(models.Objetivo).filter(
        models.Objetivo.id == objetivo_id,
        models.Objetivo.usuario_id == usuario.id
    ).first()
    if not obj:
        return {"error": "Objetivo no encontrado"}
    obj.activo = False
    db.commit()
    return {"status": "success"}


@app.post("/api/checkin")
def checkin_diario_adaptativo(
    payload: CheckinDiarioPayload,
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    try:
        sincronizar_secuencias()
        fecha_obj = (
            datetime.strptime(payload.fecha.strip(), "%Y-%m-%d").date()
            if payload.fecha else datetime.now().date()
        )
        obj = db.query(models.Objetivo).filter(
            models.Objetivo.usuario_id == usuario.id,
            models.Objetivo.activo == True
        ).order_by(models.Objetivo.prioridad.asc()).first()

        sesion_db = db.query(models.EntrenamientoProgramado).filter(
            models.EntrenamientoProgramado.usuario_id == usuario.id,
            models.EntrenamientoProgramado.fecha_programada == fecha_obj
        ).first()

        if not sesion_db:
            sesion_db = models.EntrenamientoProgramado(
                usuario_id=usuario.id,
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
            sesion_db.motivo_adaptacion = "Check-in diario: Supercompensación y descanso pasivo."
        elif sensacion == "cargadas":
            dur_real = min(min_disp, 75)
            sesion_db.tipo_sesion = f"Z1/Z2 Regenerativo Activo ({dur_real}m)"
            sesion_db.duracion_minutos_planeada = dur_real
            sesion_db.tss_planeado = round((dur_real / 60.0) * 35)
            sesion_db.entorno = entorno
            estructura = generar_estructura_respaldo("Regenerativo Z1", dur_real)
            sesion_db.estructura = json.dumps(estructura, ensure_ascii=False)
            sesion_db.motivo_adaptacion = f"Check-in diario (piernas cargadas): Rodaje regenerativo durante {dur_real} min."
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
            sesion_db.motivo_adaptacion = f"Check-in diario (piernas frescas, {min_disp} min en {entorno})."
        else:
            nombre_base = sesion_db.tipo_sesion or "Base Aeróbica Z2 + Tempo"
            if "descanso" in nombre_base.lower():
                nombre_base = "Base Aeróbica Z2 (FatMax)"
            sesion_db.tipo_sesion = f"{nombre_base.split('(')[0].strip()} ({min_disp}m)"
            sesion_db.duracion_minutos_planeada = min_disp
            sesion_db.tss_planeado = round((min_disp / 60.0) * 58)
            sesion_db.entorno = entorno
            estructura = generar_estructura_respaldo(sesion_db.tipo_sesion, min_disp)
            sesion_db.estructura = json.dumps(estructura, ensure_ascii=False) if estructura else None
            sesion_db.motivo_adaptacion = f"Check-in diario: Duración ajustada a {min_disp} min hoy."

        db.commit()
        return {"status": "success", "sesion": sesion_db.tipo_sesion, "duracion": sesion_db.duracion_minutos_planeada}
    except Exception as e:
        db.rollback()
        return {"error": str(e)}


@app.post("/chat")
def chat_entrenador(
    mensaje: MensajeChat,
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    try:
        sincronizar_secuencias()
        hoy_dt = datetime.now()
        hoy_date = hoy_dt.date()
        uid = usuario.id

        telemetria = obtener_telemetria_intervals_en_vivo(db, usuario)
        ftp_actual = telemetria["ftp"]
        peso_actual = telemetria["peso"]
        wkg_actual = telemetria["wkg"]
        lthr_actual = telemetria["lthr"]
        ctl_actual = telemetria["ctl"]
        atl_actual = telemetria["atl"]
        tsb_actual = telemetria["tsb"]

        niveles = calcular_niveles_progresion(db, uid, ftp_actual)

        hace_un_ano = hoy_dt - timedelta(days=365)
        hace_4_semanas = hoy_dt - timedelta(days=28)

        acts_ano = db.query(models.Activity).filter(
            models.Activity.usuario_id == uid,
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
            models.Objetivo.usuario_id == uid,
            models.Objetivo.activo == True
        ).order_by(models.Objetivo.prioridad.asc(), models.Objetivo.fecha_meta.asc()).all()

        obj_principal = objetivos_activos[0] if objetivos_activos else None
        disponibilidad_guardada = (
            (usuario.disponibilidad_json if usuario.disponibilidad_json else None)
            or (obj_principal.disponibilidad_semanal if obj_principal and obj_principal.disponibilidad_semanal else None)
            or "No especificada aún"
        )

        fases_db = []
        fase_activa_hoy = None
        if obj_principal:
            fases_db = db.query(models.FaseMacrociclo).filter(
                models.FaseMacrociclo.usuario_id == uid,
                models.FaseMacrociclo.objetivo_id == obj_principal.id
            ).order_by(models.FaseMacrociclo.orden.asc()).all()
            for f in fases_db:
                if f.fecha_inicio <= hoy_date <= f.fecha_fin:
                    fase_activa_hoy = f
                    break
            if not fase_activa_hoy and fases_db:
                fase_activa_hoy = fases_db[0]

        sesiones_proximas = db.query(models.EntrenamientoProgramado).filter(
            models.EntrenamientoProgramado.usuario_id == uid,
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
                    models.Objetivo.usuario_id == uid,
                    models.Objetivo.activo == True,
                    models.Objetivo.prioridad == prio_limpia
                ).first()

                if not obj and prio_limpia == "A":
                    obj = db.query(models.Objetivo).filter(
                        models.Objetivo.usuario_id == uid,
                        models.Objetivo.activo == True
                    ).first()

                if not obj:
                    obj = models.Objetivo(
                        usuario_id=uid,
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

                if disponibilidad_semanal:
                    usuario.disponibilidad_json = disponibilidad_semanal

                if fases:
                    db.query(models.FaseMacrociclo).filter(
                        models.FaseMacrociclo.usuario_id == uid,
                        models.FaseMacrociclo.objetivo_id == obj.id
                    ).delete()

                    for idx, f in enumerate(fases):
                        nueva_fase = models.FaseMacrociclo(
                            usuario_id=uid,
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
                        usuario_id=uid,
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

                if disponibilidad_semanal:
                    usuario.disponibilidad_json = disponibilidad_semanal

                resumen_guardado = []
                for s in sesiones:
                    fecha_obj = datetime.strptime(s["fecha"].strip(), "%Y-%m-%d").date()
                    sesion_db = db.query(models.EntrenamientoProgramado).filter(
                        models.EntrenamientoProgramado.usuario_id == uid,
                        models.EntrenamientoProgramado.fecha_programada == fecha_obj
                    ).first()
                    if not sesion_db:
                        sesion_db = models.EntrenamientoProgramado(
                            usuario_id=uid,
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

                    estructura = generar_estructura_respaldo(tipo_ses, dur_min)
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
                    "description": "Crea o actualiza un objetivo de la temporada y su plan completo de preparación.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "objetivo": {"type": "string"},
                            "fecha_meta": {"type": "string", "description": "YYYY-MM-DD"},
                            "prioridad": {"type": "string", "enum": ["A", "B", "C"]},
                            "disponibilidad_semanal": {"type": "string"},
                            "resumen_estrategico": {"type": "string"},
                            "bloques": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "nombre": {"type": "string"},
                                        "fecha_inicio": {"type": "string"},
                                        "fecha_fin": {"type": "string"},
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
                    "description": "Guarda en la base de datos las sesiones de la semana.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "disponibilidad_semanal": {"type": "string"},
                            "sesiones": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "fecha": {"type": "string", "description": "YYYY-MM-DD"},
                                        "tipo_sesion": {"type": "string", "description": "Título descriptivo: 'Rønnestad 30/15s', 'Sweet Spot Progresivo', 'Z2 + Fuerza Torque 65rpm', 'Z2 FatMax'."},
                                        "entorno": {"type": "string", "description": "'Indoor' o 'Outdoor'"},
                                        "duracion_minutos": {"type": "integer"},
                                        "tss": {"type": "integer"},
                                        "nota_entrenador": {"type": "string"}
                                    },
                                    "required": ["fecha", "tipo_sesion", "duracion_minutos", "tss", "nota_entrenador"]
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

        txt_objetivos = (
            " | ".join(f"[Prioridad {o.prioridad}] {o.nombre} ({o.fecha_meta})" for o in objetivos_activos)
            if objetivos_activos else "Ninguno configurado aún."
        )
        txt_bloque_hoy = (
            f"Bloque activo hoy: '{fase_activa_hoy.nombre}' ({fase_activa_hoy.fecha_inicio} a {fase_activa_hoy.fecha_fin}) - Foco: {fase_activa_hoy.foco_fisiologico or fase_activa_hoy.descripcion}"
            if fase_activa_hoy else "Sin bloques de macrociclo activos aún."
        )
        txt_sesiones_bd = (
            "; ".join(f"{s.fecha_programada} ({nombre_dia(s.fecha_programada)}): {s.tipo_sesion} ({s.duracion_minutos_planeada}m, {s.tss_planeado} TSS, {s.estado})" for s in sesiones_proximas)
            if sesiones_proximas else "Ninguna sesión programada para esta semana."
        )

        system_prompt = (
            f"Hoy es {nombre_dia(hoy_dt)} {hoy_dt.strftime('%Y-%m-%d')}.\n"
            f"Eres el Director Deportivo y Fisiólogo Jefe de {usuario.nombre}. Diseñas entrenamientos basados en evidencia científica moderna (Seiler, Rønnestad, Issurin, San Millán, Jeukendrup).\n\n"
            "📊 TELEMETRÍA EN VIVO Y NIVELES DE PROGRESIÓN:\n"
            f"- Ciclista: {usuario.nombre} | FTP actual: {ftp_actual}W | Peso: {peso_actual} kg ({wkg_actual} W/kg) | LTHR: {lthr_actual} bpm | FC Máx: {telemetria['max_hr']} bpm.\n"
            f"- Carga actual: Fitness (CTL) {ctl_actual} | Fatiga (ATL) {atl_actual} | Frescura (TSB) {tsb_actual}.\n"
            f"- Niveles de Progresión: Z2={niveles['resistencia_z2']}/10 | Torque={niveles['tempo_torque']}/10 | Sweet Spot={niveles['sweet_spot']}/10 | FTP={niveles['umbral_ftp']}/10 | VO2max={niveles['vo2max']}/10 | Durabilidad={niveles['durabilidad_kj']}/10.\n"
            f"- Últimos 365 días: {horas_ultimo_ano} h y {desnivel_ultimo_ano:,} m desnivel | Salida récord: {salida_mas_larga_h} h ({salida_mas_larga_desnivel:,} m) | Últimas 4 sem: {media_horas_ultimas_4_sem} h/sem.\n\n"
            "🧠 MEMORIA EN BASE DE DATOS:\n"
            f"- Objetivos: {txt_objetivos}\n"
            f"- Disponibilidad semanal: {disponibilidad_guardada}\n"
            f"- {txt_bloque_hoy}\n"
            f"- Agenda actual: {txt_sesiones_bd}\n\n"
            "REGLAS DE EJECUCIÓN:\n"
            f"1. Para programar esta semana, usa las fechas desde hoy hasta el domingo: [{fechas_validas_str}].\n"
            "2. En 'actualizar_calendario', da un 'tipo_sesion' descriptivo (ej. 'VO2max 4x4m', 'Torque 65rpm', 'Sweet Spot Progresivo', 'Z2 FatMax') para que el backend genere los bloques.\n"
            "3. Tras llamar a 'actualizar_calendario', presenta SIEMPRE:\n"
            "### 🗓 Planificación Semanal\n(Tabla Markdown)\n"
            f"### 🔬 Análisis Fisiológico y Ejecución (FTP {ftp_actual}W)\n"
            "### 💡 Pro-Tips del Coach"
        )

        mensajes = [{"role": "system", "content": system_prompt}]
        if mensaje.historial:
            for msg in mensaje.historial[-4:]:
                role = "assistant" if msg.rol == "ia" else "user"
                texto_recortado = msg.texto[:600] + "..." if len(msg.texto) > 600 else msg.texto
                mensajes.append({"role": role, "content": texto_recortado})
        mensajes.append({"role": "user", "content": mensaje.texto})

        herramienta_ejecutada = False
        ultimo_guardado = None

        for _ in range(2):
            try:
                kwargs_groq = {
                    "model": "openai/gpt-oss-120b" if not herramienta_ejecutada else "openai/gpt-oss-20b",
                    "messages": mensajes,
                    "max_tokens": 1800,
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
                    return {
                        "respuesta": formatear_respuesta_semanal_markdown(
                            res_emergencia.get("guardado", []),
                            ftp_actual
                        )
                    }
                if ultimo_guardado:
                    return {"respuesta": formatear_respuesta_semanal_markdown(ultimo_guardado, ftp_actual)}
                raise err_groq

            msg_ia = respuesta_ia.choices[0].message
            mensajes.append(msg_ia.model_dump(exclude_unset=True))

            if not msg_ia.tool_calls:
                return {"respuesta": msg_ia.content or "Plan actualizado correctamente."}

            for tool_call in msg_ia.tool_calls:
                func_name = tool_call.function.name
                try:
                    args = json.loads(tool_call.function.arguments)
                except json.JSONDecodeError:
                    if ultimo_guardado:
                        return {"respuesta": formatear_respuesta_semanal_markdown(ultimo_guardado, ftp_actual)}
                    return {"error_interno": "La IA se atascó al procesar los datos. Inténtalo de nuevo."}

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
                    ultimo_guardado = resultado.get("guardado")
                else:
                    resultado = {"aviso": "Consulta leída de memoria."}

                mensajes.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "name": func_name,
                    "content": json.dumps(resultado, ensure_ascii=False)
                })
                herramienta_ejecutada = True

        if ultimo_guardado:
            return {"respuesta": formatear_respuesta_semanal_markdown(ultimo_guardado, ftp_actual)}
        return {"respuesta": "He actualizado tu estructura de entrenamiento en la Agenda."}
    except Exception as e:
        return {"error_interno": f"Fallo en la matriz: {str(e)}"}


@app.get("/stats")
def obtener_estadisticas_dashboard(
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    try:
        telemetria = obtener_telemetria_intervals_en_vivo(db, usuario)
        ftp = telemetria["ftp"]
        peso = telemetria["peso"]
        niveles = calcular_niveles_progresion(db, usuario.id, ftp)

        fecha_limite = datetime.now() - timedelta(days=30)
        historial = db.query(models.Activity).filter(
            models.Activity.usuario_id == usuario.id,
            models.Activity.icu_ctl.isnot(None),
            models.Activity.start_date_local >= fecha_limite
        ).order_by(models.Activity.start_date_local.asc()).all()

        if not historial:
            ultima_act = db.query(models.Activity).filter(
                models.Activity.usuario_id == usuario.id,
                models.Activity.icu_ctl.isnot(None)
            ).order_by(models.Activity.start_date_local.desc()).first()
            ctl = round(ultima_act.icu_ctl, 1) if ultima_act else telemetria["ctl"]
            atl = round(ultima_act.icu_atl, 1) if ultima_act else telemetria["atl"]
            tsb = round(ctl - atl, 1)
            grafica_ctl = [{"value": ctl, "label": "Hoy"}] if ctl > 0 else []
            grafica_atl = [{"value": atl, "label": "Hoy"}] if atl > 0 else []
        else:
            ultima_act = historial[-1]
            ctl = round(ultima_act.icu_ctl, 1)
            atl = round(ultima_act.icu_atl, 1)
            tsb = round(ctl - atl, 1)
            grafica_ctl = [{"value": round(act.icu_ctl, 1), "label": act.start_date_local.strftime("%d/%m")} for act in historial]
            grafica_atl = [{"value": round(act.icu_atl, 1), "label": act.start_date_local.strftime("%d/%m")} for act in historial]

        prompt = (
            f"El ciclista {usuario.nombre} tiene CTL: {ctl}, ATL: {atl}, TSB: {tsb}, FTP: {ftp}W, peso: {peso}kg ({telemetria['wkg']} W/kg). "
            f"Sus niveles de progresión actuales son Z2={niveles['resistencia_z2']}/10, SweetSpot={niveles['sweet_spot']}/10, VO2max={niveles['vo2max']}/10, Durabilidad={niveles['durabilidad_kj']}/10. "
            "Escribe un diagnóstico fisiológico directo y claro (2 párrafos) sobre su estado de forma, fortalezas/limitantes y recomendaciones de carga. Sin saludos."
        )

        response = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1000
        )

        return {
            "usuario_nombre": usuario.nombre,
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
async def exportar_a_nube(
    sesion_id: int,
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    try:
        ath_id, auth_kwargs = credenciales_intervals(usuario)
        if not ath_id or not auth_kwargs:
            return {"error": "Conecta primero tu cuenta con Intervals.icu."}

        sesion = db.query(models.EntrenamientoProgramado).filter(
            models.EntrenamientoProgramado.id == sesion_id,
            models.EntrenamientoProgramado.usuario_id == usuario.id
        ).first()
        if not sesion:
            return {"error": "Sesión no encontrada"}

        estructura = cargar_estructura(sesion.estructura)
        if not estructura and sesion.duracion_minutos_planeada > 0:
            estructura = generar_estructura_respaldo(sesion.tipo_sesion, sesion.duracion_minutos_planeada)

        workout_text = estructura_a_texto_intervals(estructura) if estructura else "60m 68%"
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

        url = f"{BASE_URL}/{ath_id}/events"

        async with httpx.AsyncClient() as client_http:
            response = await client_http.post(url, json=payload, **auth_kwargs)

        if response.status_code == 200:
            return {"status": "success"}
        return {"error": f"Error {response.status_code}: {response.text}"}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/exportar/archivo/{sesion_id}")
async def exportar_archivo_fit(
    sesion_id: int,
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    try:
        ath_id, auth_kwargs = credenciales_intervals(usuario)
        if not ath_id or not auth_kwargs:
            return {"error": "Conecta tu cuenta de Intervals.icu para compilar archivos .FIT"}

        sesion = db.query(models.EntrenamientoProgramado).filter(
            models.EntrenamientoProgramado.id == sesion_id,
            models.EntrenamientoProgramado.usuario_id == usuario.id
        ).first()
        if not sesion:
            return {"error": "Sesión no encontrada"}

        estructura = cargar_estructura(sesion.estructura)
        if not estructura and sesion.duracion_minutos_planeada > 0:
            estructura = generar_estructura_respaldo(sesion.tipo_sesion, sesion.duracion_minutos_planeada)

        workout_text = estructura_a_texto_intervals(estructura) if estructura else "60m 68%"
        payload = {
            "start_date_local": f"{sesion.fecha_programada}T00:00:00",
            "type": "Ride",
            "category": "WORKOUT",
            "name": f"AI Coach: {sesion.tipo_sesion[:24]}",
            "description": workout_text
        }
        url_events = f"{BASE_URL}/{ath_id}/events"

        async with httpx.AsyncClient() as client_http:
            resp_post = await client_http.post(url_events, json=payload, **auth_kwargs)
            if resp_post.status_code != 200:
                return {"error": "Fallo en la compilación"}

            evento_id = resp_post.json().get("id")
            url_fit = f"{BASE_URL}/{ath_id}/events/{evento_id}/download.fit"
            resp_fit = await client_http.get(url_fit, **auth_kwargs)

            return Response(
                content=resp_fit.content,
                media_type="application/vnd.ant.fit",
                headers={"Content-Disposition": f'attachment; filename="{sesion.tipo_sesion[:10]}.fit"'}
            )
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/calendario")
def get_calendario(
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    try:
        hoy = datetime.now().date()
        uid = usuario.id
        telemetria = obtener_telemetria_intervals_en_vivo(db, usuario)

        objetivos = db.query(models.Objetivo).filter(
            models.Objetivo.usuario_id == uid,
            models.Objetivo.activo == True
        ).order_by(models.Objetivo.prioridad.asc(), models.Objetivo.fecha_meta.asc()).all()

        obj = objetivos[0] if objetivos else None

        fases_db = []
        if obj and hasattr(models, "FaseMacrociclo"):
            try:
                fases_db = db.query(models.FaseMacrociclo).filter(
                    models.FaseMacrociclo.usuario_id == uid,
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

        inicio_semana = hoy - timedelta(days=hoy.weekday())
        sesiones = db.query(models.EntrenamientoProgramado).filter(
            models.EntrenamientoProgramado.usuario_id == uid,
            models.EntrenamientoProgramado.fecha_programada >= inicio_semana
        ).order_by(models.EntrenamientoProgramado.fecha_programada.asc()).limit(14).all()

        hace_30d = datetime.now() - timedelta(days=30)
        acts_recientes = db.query(models.Activity).filter(
            models.Activity.usuario_id == uid,
            models.Activity.start_date_local >= hace_30d
        ).order_by(models.Activity.start_date_local.desc()).limit(35).all()

        mapa_actividades_por_fecha = {}
        actividades_formateadas = []
        ftp_ref = max(150, telemetria["ftp"])

        for a in acts_recientes:
            if not a.start_date_local:
                continue
            fecha_str = a.start_date_local.strftime("%Y-%m-%d")
            dur_min = round((a.moving_time or 0) / 60)
            dist_km = round((a.distance or 0) / 1000.0, 1)
            desnivel_m = int(a.total_elevation_gain or 0)
            np_w = int(a.normalized_power or 0)
            hr_avg = int(a.average_heartrate or 0)
            tss_act = int(round(a.tss or 0))
            if_act = round(np_w / ftp_ref, 2) if np_w > 0 else 0.0
            kj_act = int(round((np_w * (a.moving_time or 0)) / 1000.0)) if np_w > 0 else 0

            item_act = {
                "id": str(a.id),
                "fecha": fecha_str,
                "nombre": a.name or "Salida en bicicleta",
                "tipo": a.type or "Ride",
                "duracion_min": dur_min,
                "distancia_km": dist_km,
                "desnivel_m": desnivel_m,
                "tss": tss_act,
                "np": np_w,
                "if_val": if_act,
                "hr_avg": hr_avg,
                "kj": kj_act,
            }
            actividades_formateadas.append(item_act)
            if fecha_str not in mapa_actividades_por_fecha or dur_min > mapa_actividades_por_fecha[fecha_str]["duracion_min"]:
                mapa_actividades_por_fecha[fecha_str] = item_act

        ctl_v = telemetria["ctl"]
        atl_v = telemetria["atl"]
        tsb_v = telemetria["tsb"]
        acwr = round(atl_v / max(15.0, ctl_v), 2) if ctl_v > 0 else 1.0

        score = 75
        if tsb_v >= 5:
            score += 15
        elif tsb_v >= -10:
            score += 5
        elif tsb_v >= -22:
            score -= 12
        else:
            score -= 30

        if acwr > 1.35:
            score -= 15
        elif 0.85 <= acwr <= 1.20:
            score += 5

        if telemetria.get("sleep_hours"):
            if telemetria["sleep_hours"] >= 7.5:
                score += 8
            elif telemetria["sleep_hours"] < 6.0:
                score -= 15

        score = max(15, min(99, score))
        if score >= 75:
            veredicto_rt = "TRAIN HARD"
            color_rt = "#10b981"
            consejo_rt = f"Luz verde ({score}%). TSB en {tsb_v} (ACWR {acwr}). Óptimo para completar las series clave."
        elif score >= 48:
            veredicto_rt = "TRAIN MODERATE"
            color_rt = "#f59e0b"
            consejo_rt = f"Carga moderada ({score}%). TSB en {tsb_v} (ACWR {acwr}). Prioriza precisión en Z2/Z3 sin picos máximos."
        else:
            veredicto_rt = "REST OR Z1"
            color_rt = "#f43f5e"
            consejo_rt = f"Fatiga alta ({score}%). TSB en {tsb_v} (ACWR {acwr}). Convierte hoy a Z1 Regenerativo o descanso."

        nombre_obj = obj.nombre if obj else "Configura tu Objetivo"
        fecha_obj = obj.fecha_meta.strftime("%Y-%m-%d") if (obj and obj.fecha_meta) else None
        disp_actual = (
            (usuario.disponibilidad_json if usuario.disponibilidad_json else None)
            or (obj.disponibilidad_semanal if obj else None)
        )

        sesiones_salida = []
        hubo_autopoblado = False
        for s in sesiones:
            f_str = s.fecha_programada.strftime("%Y-%m-%d")
            act_asociada = mapa_actividades_por_fecha.get(f_str)
            estado_final = "Completado" if (s.estado == "Completado" or act_asociada) else s.estado
            tss_real_final = getattr(s, "tss_real", None) or (act_asociada["tss"] if act_asociada else None)

            est_cargada = cargar_estructura(getattr(s, "estructura", None))
            if not est_cargada and (s.duracion_minutos_planeada or 0) > 0:
                est_cargada = generar_estructura_respaldo(s.tipo_sesion, s.duracion_minutos_planeada)
                if est_cargada:
                    s.estructura = json.dumps(est_cargada, ensure_ascii=False)
                    hubo_autopoblado = True

            sesiones_salida.append({
                "id": s.id,
                "fecha": f_str,
                "sesion": s.tipo_sesion,
                "entorno": s.entorno,
                "duracion": s.duracion_minutos_planeada,
                "tss": s.tss_planeado,
                "tss_real": tss_real_final,
                "estado": estado_final,
                "nota": s.motivo_adaptacion,
                "estructura": est_cargada,
                "actividad_real": act_asociada
            })

        if hubo_autopoblado:
            db.commit()

        return {
            "usuario": serializar_usuario(usuario),
            "telemetria": {
                "ftp": telemetria["ftp"],
                "peso": telemetria["peso"],
                "lthr": telemetria["lthr"],
                "max_hr": telemetria["max_hr"],
                "ctl": ctl_v,
                "atl": atl_v,
                "tsb": tsb_v,
                "hrv": telemetria.get("hrv"),
                "resting_hr": telemetria.get("resting_hr"),
                "sleep_hours": telemetria.get("sleep_hours"),
                "objetivo": nombre_obj,
                "fecha_meta": fecha_obj,
                "rest_or_train": {
                    "score": score,
                    "veredicto": veredicto_rt,
                    "color": color_rt,
                    "acwr": acwr,
                    "consejo": consejo_rt
                }
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
            "sesiones": sesiones_salida,
            "actividades_realizadas": actividades_formateadas
        }
    except Exception as e:
        print(f"Error protegido en get_calendario: {e}")
        return {
            "telemetria": {"ftp": 250, "peso": 70.0, "lthr": 175, "max_hr": 195, "objetivo": "Configura tu Objetivo", "fecha_meta": None},
            "macrociclo": {"objetivo": "Configura tu Objetivo", "fecha_meta": None, "total_fases": 0, "resumen_estrategico": None, "fase_activa": None, "fases": []},
            "sesiones": [],
            "actividades_realizadas": []
        }


@app.post("/api/calendario/toggle/{sesion_id}")
def toggle_estado_sesion(
    sesion_id: int,
    usuario: models.Usuario = Depends(obtener_usuario_actual),
    db: Session = Depends(get_db)
):
    sesion = db.query(models.EntrenamientoProgramado).filter(
        models.EntrenamientoProgramado.id == sesion_id,
        models.EntrenamientoProgramado.usuario_id == usuario.id
    ).first()
    if not sesion:
        return {"error": "Sesión no encontrada"}

    sesion.estado = "Completado" if sesion.estado != "Completado" else "Pendiente"
    db.commit()
    return {"status": "success", "nuevo_estado": sesion.estado}