from fastapi import FastAPI, Depends, Response
import os
import httpx
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from pydantic import BaseModel
import json
from groq import Groq
from typing import List, Optional

from database import SessionLocal, engine, Base, get_db
import models
import workout_generator

app = FastAPI(title="AI Cycling Coach API")

# 1. Crear tablas en la BD (incluyendo FaseMacrociclo si está en models.py)
models.Base.metadata.create_all(bind=engine)

# 2. Configurar el cliente de Groq
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# 3. Asegurar usuario principal (ID 1) en el arranque
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
                ftp_actual=305
            )
            db.add(nuevo_usuario)
            db.commit()
            print("Usuario principal creado con éxito en el arranque.")
    except Exception as e:
        print(f"Nota sobre el usuario inicial: {e}")
    finally:
        db.close()

ATHLETE_ID = os.getenv("INTERVALS_ATHLETE_ID")
API_KEY = os.getenv("INTERVALS_API_KEY")
BASE_URL = "https://intervals.icu/api/v1/athlete"

class MensajeHistorial(BaseModel):
    rol: str
    texto: str

class MensajeChat(BaseModel):
    texto: str
    historial: Optional[List[MensajeHistorial]] = []

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Backend listo para descargar datos de Intervals.icu y hablar con la IA"}

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
        async with httpx.AsyncClient() as client_http:
            response = await client_http.get(url, params=params, auth=auth)
            
        if response.status_code != 200:
            return {"status": "cached", "message": "Usando datos locales (Intervals.icu no responde)"}
    except Exception:
        return {"status": "cached", "message": "Usando datos locales (Error de conexión)"}
        
    activities_data = response.json()
    inserted_count = 0
    updated_count = 0

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
            
    db.commit()
    
    return {
        "status": "success", 
        "inserted": inserted_count, 
        "updated": updated_count,
        "total_processed": len(activities_data)
    }

@app.post("/chat")
def chat_entrenador(mensaje: MensajeChat, db: Session = Depends(get_db)):
    try:
        hoy_dt = datetime.now()
        hoy_date = hoy_dt.date()

        # 1. Dossier Histórico y Fisiológico Real extraído de PostgreSQL
        act_con_ftp = db.query(models.Activity).filter(
            models.Activity.usuario_id == 1,
            models.Activity.icu_ftp.isnot(None)
        ).order_by(models.Activity.start_date_local.desc()).first()
        ftp_actual = act_con_ftp.icu_ftp if act_con_ftp else 305
        ctl_actual = round(act_con_ftp.icu_ctl, 1) if (act_con_ftp and act_con_ftp.icu_ctl) else 0
        atl_actual = round(act_con_ftp.icu_atl, 1) if (act_con_ftp and act_con_ftp.icu_atl) else 0

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

        # 2. Herramientas Nativas en Python (Macrociclo + Microciclo)
        def consultar_calendario():
            obj = db.query(models.Objetivo).filter(
                models.Objetivo.usuario_id == 1,
                models.Objetivo.activo == True
            ).first()
            if not obj:
                return {"aviso": "El usuario no tiene ningún objetivo ni macrociclo configurado aún."}

            fases = db.query(models.FaseMacrociclo).filter(
                models.FaseMacrociclo.usuario_id == 1,
                models.FaseMacrociclo.objetivo_id == obj.id
            ).order_by(models.FaseMacrociclo.orden.asc()).all()

            fase_activa = None
            for f in fases:
                if f.fecha_inicio <= hoy_date <= f.fecha_fin:
                    fase_activa = f.nombre
                    break

            sesiones = db.query(models.EntrenamientoProgramado).filter(
                models.EntrenamientoProgramado.usuario_id == 1,
                models.EntrenamientoProgramado.objetivo_id == obj.id,
                models.EntrenamientoProgramado.fecha_programada >= hoy_date
            ).order_by(models.EntrenamientoProgramado.fecha_programada.asc()).limit(10).all()

            return {
                "objetivo": obj.nombre,
                "fecha_meta": str(obj.fecha_meta),
                "resumen_estrategico": fases[0].resumen_estrategico if fases else None,
                "fase_activa_hoy": fase_activa,
                "fases_macrociclo": [
                    {
                        "orden": f.orden,
                        "nombre": f.nombre,
                        "inicio": str(f.fecha_inicio),
                        "fin": str(f.fecha_fin),
                        "foco": f.foco_fisiologico,
                        "descripcion": f.descripcion
                    } for f in fases
                ],
                "proximas_sesiones": [
                    {
                        "fecha": str(s.fecha_programada),
                        "tipo": s.tipo_sesion,
                        "duracion_min": s.duracion_minutos_planeada,
                        "tss": s.tss_planeado
                    } for s in sesiones
                ]
            }

        def estructurar_macrociclo(objetivo, fecha_meta, resumen_estrategico, fases=[]):
            try:
                obj = db.query(models.Objetivo).filter(
                    models.Objetivo.usuario_id == 1,
                    models.Objetivo.activo == True
                ).first()
                fecha_meta_dt = datetime.strptime(fecha_meta, "%Y-%m-%d").date()

                if not obj:
                    obj = models.Objetivo(
                        usuario_id=1,
                        nombre=objetivo,
                        fecha_meta=fecha_meta_dt,
                        activo=True
                    )
                    db.add(obj)
                    db.commit()
                    db.refresh(obj)
                else:
                    obj.nombre = objetivo
                    obj.fecha_meta = fecha_meta_dt

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
                        fecha_inicio=datetime.strptime(f["fecha_inicio"], "%Y-%m-%d").date(),
                        fecha_fin=datetime.strptime(f["fecha_fin"], "%Y-%m-%d").date(),
                        descripcion=f.get("descripcion", ""),
                        foco_fisiologico=f.get("foco_fisiologico", ""),
                        resumen_estrategico=resumen_estrategico if idx == 0 else None
                    )
                    db.add(nueva_fase)

                db.commit()
                return {
                    "resultado": f"Macrociclo para '{objetivo}' guardado con éxito con {len(fases)} bloques."
                }
            except Exception as e:
                db.rollback()
                return {"error": str(e)}

        def actualizar_calendario(objetivo=None, fecha_meta=None, sesiones=[]):
            try:
                obj = db.query(models.Objetivo).filter(
                    models.Objetivo.usuario_id == 1,
                    models.Objetivo.activo == True
                ).first()
                if not obj:
                    obj = models.Objetivo(
                        usuario_id=1,
                        nombre=objetivo or "Everesting",
                        fecha_meta=datetime.strptime(fecha_meta or "2027-08-25", "%Y-%m-%d").date()
                    )
                    db.add(obj)
                    db.commit()
                    db.refresh(obj)
                else:
                    if objetivo: obj.nombre = objetivo
                    if fecha_meta: obj.fecha_meta = datetime.strptime(fecha_meta, "%Y-%m-%d").date()

                for s in sesiones:
                    fecha_obj = datetime.strptime(s["fecha"], "%Y-%m-%d").date()
                    sesion_db = db.query(models.EntrenamientoProgramado).filter(
                        models.EntrenamientoProgramado.usuario_id == 1,
                        models.EntrenamientoProgramado.fecha_programada == fecha_obj,
                        models.EntrenamientoProgramado.objetivo_id == obj.id
                    ).first()
                    if not sesion_db:
                        sesion_db = models.EntrenamientoProgramado(
                            usuario_id=1,
                            objetivo_id=obj.id,
                            fecha_programada=fecha_obj
                        )
                        db.add(sesion_db)
                    sesion_db.tipo_sesion = s.get("tipo_sesion", "Descanso")
                    sesion_db.entorno = s.get("entorno", "Indoor")
                    sesion_db.duracion_minutos_planeada = int(s.get("duracion_minutos", 0))
                    sesion_db.tss_planeado = int(s.get("tss", 0))
                    sesion_db.estado = s.get("estado", "Pendiente")
                    if s.get("nota_entrenador"):
                        sesion_db.motivo_adaptacion = s.get("nota_entrenador")
                db.commit()
                return {"resultado": "Sesiones del microciclo actualizadas con éxito."}
            except Exception as e:
                db.rollback()
                return {"error": str(e)}

        # 3. Definición de Herramientas para Groq
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "consultar_calendario",
                    "description": "Lee la base de datos para ver el objetivo actual, los bloques/fases del macrociclo, la fase activa hoy y los próximos entrenamientos.",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "estructurar_macrociclo",
                    "description": "Crea o actualiza el plan completo de preparación por bloques/fases (macrociclo) desde hoy hasta la fecha del objetivo final.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "objetivo": {"type": "string", "description": "Nombre del objetivo (ej. Everesting)."},
                            "fecha_meta": {"type": "string", "description": "Fecha final del reto en formato YYYY-MM-DD."},
                            "resumen_estrategico": {
                                "type": "string",
                                "description": "Diagnóstico experto de 2 párrafos analizando el historial real del ciclista (horas, desnivel anual, salida récord, volumen reciente) y la estrategia global hacia el objetivo."
                            },
                            "fases": {
                                "type": "array",
                                "description": "Lista cronológica y continua de bloques/fases que cubren desde la fecha actual hasta la fecha_meta.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "nombre": {"type": "string", "description": "Título claro del bloque (ej. 'Recuperar continuidad', 'Base aeróbica', 'Fuerza-resistencia en subida')."},
                                        "fecha_inicio": {"type": "string", "description": "YYYY-MM-DD"},
                                        "fecha_fin": {"type": "string", "description": "YYYY-MM-DD"},
                                        "descripcion": {"type": "string", "description": "Explicación detallada del propósito fisiológico, mental, nutricional y de carga de este bloque."},
                                        "foco_fisiologico": {"type": "string", "description": "Zonas de potencia prioritarias, cadencia y tipo de sesiones clave del bloque."}
                                    },
                                    "required": ["nombre", "fecha_inicio", "fecha_fin", "descripcion"]
                                }
                            }
                        },
                        "required": ["objetivo", "fecha_meta", "resumen_estrategico", "fases"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "actualizar_calendario",
                    "description": "Programa o modifica las sesiones de entrenamiento de la semana actual alineadas con el bloque activo del macrociclo.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "objetivo": {"type": "string"},
                            "fecha_meta": {"type": "string"},
                            "sesiones": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "fecha": {"type": "string"},
                                        "tipo_sesion": {"type": "string"},
                                        "entorno": {"type": "string"},
                                        "duracion_minutos": {"type": "integer"},
                                        "tss": {"type": "integer"},
                                        "nota_entrenador": {"type": "string", "description": "Por qué esta sesión ayuda al bloque actual del macrociclo."}
                                    },
                                    "required": ["fecha", "tipo_sesion", "duracion_minutos"]
                                }
                            }
                        }
                    }
                }
            }
        ]

        dias_hasta_domingo = 6 - hoy_dt.weekday()
        fechas_validas = [(hoy_dt + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(dias_hasta_domingo + 1)]
        fechas_validas_str = ", ".join(fechas_validas)

        system_prompt = (
            f"Hoy es {hoy_dt.strftime('%Y-%m-%d')}.\n"
            "Eres el Director Deportivo y Fisiólogo Jefe de Diego Allue. Tu misión es diseñar una preparación de élite basada en evidencia científica y en sus datos reales.\n\n"
            
            "📊 DOSSIER HISTÓRICO REAL DE DIEGO (EXTRAÍDO DE SU BASE DE DATOS):\n"
            f"- FTP Validado: {ftp_actual}W (~{round(ftp_actual/71.0, 2)} W/kg para 71 kg).\n"
            f"- Estado de forma actual: Fitness (CTL) {ctl_actual} | Fatiga (ATL) {atl_actual} | Balance (TSB) {round(ctl_actual - atl_actual, 1)}.\n"
            f"- Volumen últimos 365 días: {horas_ultimo_ano} horas acumuladas y {desnivel_ultimo_ano:,} m de desnivel positivo.\n"
            f"- Mayor jornada registrada en el último año: {salida_mas_larga_h} h con {salida_mas_larga_desnivel:,} m de desnivel positivo.\n"
            f"- Tendencia reciente (últimas 4 semanas): promedio de {media_horas_ultimas_4_sem} h/semana.\n\n"

            "1. ARQUITECTURA DE PERIODIZACIÓN POR BLOQUES (MACROCICLO):\n"
            "- No utilices plantillas genéricas. Analiza siempre la brecha fisiológica entre el estado actual de Diego (su volumen reciente vs. su historial anual) y las demandas específicas de su objetivo.\n"
            "- PROTOCOLO DE ENTREVISTA EXPERTA: Cuando Diego te pida estructurar un plan o macrociclo para un objetivo, verifica primero si conoces: (a) fecha exacta del reto, (b) horas semanales sostenibles actuales (L-V y fin de semana), y (c) detalles específicos del reto (ej. si ya tiene puerto elegido/pendiente media o si aún está por definir). Si falta algún dato clave para que el plan sea quirúrgico, hazle 2 o 3 preguntas directas y breves como un entrenador profesional antes de cerrarlo. Si ya te da los datos o te pide que lo estructures directamente con tu criterio, llama a la herramienta 'estructurar_macrociclo' creando los bloques óptimos desde hoy hasta la fecha meta.\n"
            "- Al redactar 'resumen_estrategico' y las 'fases' en 'estructurar_macrociclo', cita sus métricas históricas reales (horas último año, desnivel acumulado, salida más larga, horas recientes) para justificar por qué empieza con ese primer bloque.\n\n"

            "2. COHERENCIA ENTRE EL BLOQUE ACTIVO Y LOS ENTRENAMIENTOS SEMANALES:\n"
            "- Antes de programar una semana con 'actualizar_calendario', consulta siempre en qué Fase/Bloque del macrociclo se encuentra hoy llamando a 'consultar_calendario'.\n"
            "- Cada entrenamiento semanal debe cumplir estrictamente la función fisiológica del bloque activo (ej. si está en 'Recuperar continuidad', prioriza consistencia, cadencia y Z2 sin sobrecargar; si está en 'Fuerza-resistencia en subida', prioriza bloques sostenidos Z3/Sweet Spot a baja cadencia y torque).\n"
            "- Usa RANGOS de potencia realistas (ej. 200-225W, 65-75% FTP) en lugar de exigir un único vatio fijo.\n"
            f"- Para 'esta semana', las únicas fechas válidas desde hoy hasta el domingo son: [{fechas_validas_str}].\n\n"

            "3. FORMATO INNEGOCIABLE PARA PLANIFICACIÓN:\n"
            "- Si diseñas o muestras el Macrociclo, presenta primero el Diagnóstico Estratégico y luego la lista numerada de Fases con sus fechas y propósito fisiológico.\n"
            "- SOLO cuando el usuario pida crear, ver o reestructurar la semana de entrenamiento, usa esta estructura:\n"
            "### 🗓 Planificación Semanal\n"
            "(Tabla Markdown: Día | Entorno | Duración | Sesión | TSS | Enfoque del Bloque)\n\n"
            "### 🔬 Análisis Fisiológico y Ejecución\n"
            "(Desglose por día con pasos y RANGOS de vatios calculados sobre su FTP actual).\n\n"
            "### 💡 Pro-Tips del Coach\n"
            "(2 o 3 viñetas con estrategias de nutrición, hidratación o cadencia.)"
        )

        mensajes = [{"role": "system", "content": system_prompt}]
        if mensaje.historial:
            for msg in mensaje.historial[-6:]:
                role = "assistant" if msg.rol == "ia" else "user"
                mensajes.append({"role": role, "content": msg.texto})
        mensajes.append({"role": "user", "content": mensaje.texto})

        for _ in range(4):
            respuesta_ia = client.chat.completions.create(
                model="openai/gpt-oss-120b",
                messages=mensajes,
                tools=tools,
                tool_choice="auto",
                max_tokens=4096
            )
            msg_ia = respuesta_ia.choices[0].message
            mensajes.append(msg_ia.model_dump(exclude_unset=True))

            if not msg_ia.tool_calls:
                return {"respuesta": msg_ia.content or "Plan actualizado correctamente."}

            for tool_call in msg_ia.tool_calls:
                func_name = tool_call.function.name
                args = json.loads(tool_call.function.arguments)

                if func_name == "consultar_calendario":
                    resultado = consultar_calendario()
                elif func_name == "estructurar_macrociclo":
                    resultado = estructurar_macrociclo(
                        objetivo=args.get("objetivo"),
                        fecha_meta=args.get("fecha_meta"),
                        resumen_estrategico=args.get("resumen_estrategico"),
                        fases=args.get("fases", [])
                    )
                elif func_name == "actualizar_calendario":
                    resultado = actualizar_calendario(
                        objetivo=args.get("objetivo"),
                        fecha_meta=args.get("fecha_meta"),
                        sesiones=args.get("sesiones", [])
                    )
                else:
                    resultado = {"error": "Herramienta desconocida"}

                mensajes.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "name": func_name,
                    "content": json.dumps(resultado)
                })

        return {"respuesta": "He actualizado tu estructura de entrenamiento correctamente."}
    except Exception as e:
        return {"error_interno": f"Fallo en la matriz: {str(e)}"}

@app.get("/stats")
def obtener_estadisticas_dashboard(db: Session = Depends(get_db)):
    try:
        fecha_limite = datetime.now() - timedelta(days=30)
        historial = db.query(models.Activity).filter(
            models.Activity.icu_ctl.isnot(None),
            models.Activity.start_date_local >= fecha_limite
        ).order_by(models.Activity.start_date_local.asc()).all()

        if not historial:
            ultima_act = db.query(models.Activity).filter(models.Activity.icu_ctl.isnot(None)).order_by(models.Activity.start_date_local.desc()).first()
            if not ultima_act:
                return {"error": "No hay suficientes datos. Sincroniza con Intervals.icu primero."}
            historial = [ultima_act]

        ultima_act = historial[-1]
        ctl = round(ultima_act.icu_ctl, 1)
        atl = round(ultima_act.icu_atl, 1)
        tsb = round(ctl - atl, 1)
        ftp = ultima_act.icu_ftp or 0 

        grafica_ctl = [{"value": round(act.icu_ctl, 1), "label": act.start_date_local.strftime("%d/%m")} for act in historial]
        grafica_atl = [{"value": round(act.icu_atl, 1), "label": act.start_date_local.strftime("%d/%m")} for act in historial]

        prompt = f"El atleta tiene CTL: {ctl}, ATL: {atl}, TSB: {tsb} y su FTP actual es {ftp}W. Escribe un análisis directo y claro (2 párrafos) de su estado de forma y fatiga. Sin saludos."
        
        response = client.chat.completions.create(
            model="openai/gpt-oss-20b",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=4096
        )

        return {
            "fitness_ctl": ctl,
            "fatiga_atl": atl,
            "frescura_tsb": tsb,
            "ftp_actual": ftp,
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

        prompt = f"""
        Convierte esta sesión en formato de texto estricto para Intervals.icu.
        Sesión: '{sesion.tipo_sesion}'
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

        payload = {
            "start_date_local": f"{sesion.fecha_programada}T00:00:00",
            "type": "Ride",
            "category": "WORKOUT",
            "name": f"AI Coach: {sesion.tipo_sesion[:20]}",
            "description": f"Sesión generada por AI Cycling Coach para tu Everesting.\n\n{workout_text}",
            "indoor": True if sesion.entorno == 'Indoor' else False
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

        prompt = f"Convierte esta sesión para Intervals. Sesión: '{sesion.tipo_sesion}'. Reglas: Usa 'm' y '%'. Devuelve ÚNICAMENTE las líneas."
        respuesta_ia = client.chat.completions.create(model="openai/gpt-oss-20b", messages=[{"role": "user", "content": prompt}], max_tokens=500)
        workout_text = respuesta_ia.choices[0].message.content.strip()
        if workout_text.startswith("```"):
            workout_text = "\n".join(workout_text.split("\n")[1:-1]).strip()

        payload = {
            "start_date_local": f"{sesion.fecha_programada}T00:00:00",
            "type": "Ride",
            "category": "WORKOUT",
            "name": f"AI Coach: {sesion.tipo_sesion[:20]}",
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

        act_con_ftp = db.query(models.Activity).filter(
            models.Activity.usuario_id == 1,
            models.Activity.icu_ftp.isnot(None)
        ).order_by(models.Activity.start_date_local.desc()).first()
        ftp_actual = act_con_ftp.icu_ftp if act_con_ftp else 305

        obj = db.query(models.Objetivo).filter(
            models.Objetivo.usuario_id == 1,
            models.Objetivo.activo == True
        ).first()

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

        nombre_obj = obj.nombre if obj else "Everesting"
        fecha_obj = obj.fecha_meta.strftime("%Y-%m-%d") if (obj and obj.fecha_meta) else "2027-08-25"

        return {
            "telemetria": {
                "ftp": ftp_actual,
                "peso": 71.0,
                "lthr": 180,
                "max_hr": 208,
                "objetivo": nombre_obj,
                "fecha_meta": fecha_obj
            },
            "macrociclo": {
                "objetivo": nombre_obj,
                "fecha_meta": fecha_obj,
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
                    "estado": s.estado,
                    "nota": s.motivo_adaptacion
                } for s in sesiones
            ]
        }
    except Exception as e:
        print(f"Error protegido en get_calendario: {e}")
        return {
            "telemetria": {"ftp": 305, "peso": 71.0, "lthr": 173, "max_hr": 197, "objetivo": "Everesting", "fecha_meta": "2027-08-25"},
            "macrociclo": {"objetivo": "Everesting", "fecha_meta": "2027-08-25", "total_fases": 0, "resumen_estrategico": None, "fase_activa": None, "fases": []},
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