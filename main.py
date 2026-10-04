from fastapi import FastAPI, Depends
import os
import httpx
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from pydantic import BaseModel
import json
from groq import Groq

# Nuevas importaciones del SDK moderno de Gemini
from google import genai
from google.genai import types

from database import engine, Base, get_db
import models
import workout_generator

from fastapi import APIRouter
from sqlalchemy.orm import Session
from datetime import datetime

from typing import List, Optional


# 1. Crear tablas en la BD
models.Base.metadata.create_all(bind=engine)

# 2. Configurar el nuevo cliente de Groq
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

app = FastAPI(title="AI Cycling Coach API")

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
        act_db = existing_act or models.Activity(id=act.get("id"))
        
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
        # 1. Extraer FTP
        act_con_ftp = db.query(models.Activity).filter(models.Activity.icu_ftp.isnot(None)).order_by(models.Activity.start_date_local.desc()).first()
        ftp_actual = act_con_ftp.icu_ftp if act_con_ftp else 200

        # 2. Las funciones nativas (Herramientas reales de Python)
        def consultar_calendario():
            hoy = datetime.now().date()
            obj = db.query(models.Objetivo).filter(models.Objetivo.activo == True).first()
            if not obj:
                return {"aviso": "El usuario no tiene ningún objetivo configurado aún."}
            sesiones = db.query(models.EntrenamientoProgramado).filter(
                models.EntrenamientoProgramado.objetivo_id == obj.id,
                models.EntrenamientoProgramado.fecha_programada >= hoy
            ).order_by(models.EntrenamientoProgramado.fecha_programada.asc()).limit(7).all()
            return {
                "objetivo": obj.nombre,
                "fecha_meta": str(obj.fecha_meta),
                "proximas_sesiones": [{"fecha": str(s.fecha_programada), "tipo": s.tipo_sesion} for s in sesiones]
            }

        def actualizar_calendario(objetivo=None, fecha_meta=None, sesiones=[]):
            try:
                obj = db.query(models.Objetivo).filter(models.Objetivo.activo == True).first()
                if not obj:
                    obj = models.Objetivo(nombre=objetivo or "Sin definir", fecha_meta=datetime.strptime(fecha_meta or "2027-01-01", "%Y-%m-%d").date())
                    db.add(obj)
                    db.commit()
                    db.refresh(obj)
                else:
                    if objetivo: obj.nombre = objetivo
                    if fecha_meta: obj.fecha_meta = datetime.strptime(fecha_meta, "%Y-%m-%d").date()

                for s in sesiones:
                    fecha_obj = datetime.strptime(s["fecha"], "%Y-%m-%d").date()
                    sesion_db = db.query(models.EntrenamientoProgramado).filter(
                        models.EntrenamientoProgramado.fecha_programada == fecha_obj,
                        models.EntrenamientoProgramado.objetivo_id == obj.id
                    ).first()
                    if not sesion_db:
                        sesion_db = models.EntrenamientoProgramado(objetivo_id=obj.id, fecha_programada=fecha_obj)
                        db.add(sesion_db)
                    sesion_db.tipo_sesion = s.get("tipo_sesion", "Descanso")
                    sesion_db.entorno = s.get("entorno", "Indoor")
                    sesion_db.duracion_minutos_planeada = int(s.get("duracion_minutos", 0))
                    sesion_db.tss_planeado = int(s.get("tss", 0))
                    sesion_db.estado = s.get("estado", "Pendiente")
                db.commit()
                return {"resultado": "Base de datos actualizada con éxito."}
            except Exception as e:
                db.rollback()
                return {"error": str(e)}

        # 3. Definición estricta de las herramientas para la API (El nuevo estándar)
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "consultar_calendario",
                    "description": "Lee la base de datos para ver el objetivo actual del atleta, su fecha límite y sus próximos entrenamientos.",
                    "parameters": {"type": "object", "properties": {}}
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "actualizar_calendario",
                    "description": "Actualiza el objetivo general, la fecha de la meta, o programa nuevas sesiones de entrenamiento.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "objetivo": {"type": "string", "description": "El nombre de la meta (ej. Everesting)."},
                            "fecha_meta": {"type": "string", "description": "Fecha en formato YYYY-MM-DD."},
                            "sesiones": {
                                "type": "array",
                                "description": "Lista de sesiones a programar. Déjalo vacío si el usuario solo quiere cambiar el objetivo general.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "fecha": {"type": "string"},
                                        "tipo_sesion": {"type": "string"},
                                        "entorno": {"type": "string"},
                                        "duracion_minutos": {"type": "integer"},
                                        "tss": {"type": "integer"}
                                    },
                                    "required": ["fecha", "tipo_sesion", "duracion_minutos"]
                                }
                            }
                        }
                    }
                }
            }
        ]

        # 4. Prompt de Sistema (Limpio y directo)
        hoy_dt = datetime.now()
        dias_hasta_domingo = 6 - hoy_dt.weekday()
        domingo_dt = hoy_dt + timedelta(days=dias_hasta_domingo)
                
        fecha_hoy_str = hoy_dt.strftime("%Y-%m-%d")
        fecha_domingo_str = domingo_dt.strftime("%Y-%m-%d")
        
        system_prompt = (
            f"Hoy es {fecha_hoy_str}. El domingo de esta semana es {fecha_domingo_str}.\n"
            f"Eres el entrenador experto en ciclismo de Diego. Su FTP actual validado en la base de datos es de {ftp_actual}W.\n\n"
            
            "1. IDENTIDAD Y ADAPTABILIDAD:\n"
            "Eres una IA conversacional capaz de razonar sobre cualquier aspecto del ciclismo (fisiología, material, nutrición, táctica). "
            "Responde de forma natural, directa y experta a cualquier duda del usuario. Si pregunta cosas ajenas al deporte, reconduce la charla educadamente. "
            "NO asumas su objetivo. Si no lo sabes, llama a tu herramienta 'consultar_calendario' para leerlo de la base de datos, o pregúntaselo directamente para poder gestionar sub-objetivos y picos de forma.\n\n"
            
            "2. FORMATO INNEGOCIABLE PARA PLANIFICACIÓN:\n"
            "Tienes libertad total para decidir qué entrenamientos le convienen a Diego según su estado y objetivo. SIN EMBARGO, el formato en el que se los presentas es estricto. "
            "SOLO cuando el usuario pida explícitamente crear, ver o reestructurar un plan de entrenamiento, tu respuesta final DEBE seguir esta estructura visual:\n"
            "### 🗓 Planificación Semanal\n"
            "(Tabla Markdown: Día | Entorno | Duración | Sesión | TSS | Comentarios breves)\n\n"
            "### 🔬 Análisis Fisiológico y Ejecución\n"
            "(Desglose por día con pasos exactos y VATIOS calculados matemáticamente basándote SIEMPRE en su FTP actual de la base de datos).\n"
            "**Impacto Fisiológico:** Sistemas energéticos y adaptaciones generadas.\n\n"
            "### 💡 Pro-Tips del Coach\n"
            "(2 o 3 viñetas con estrategias de nutrición, hidratación o cadencia.)\n\n"
            
            "3. USO DE HERRAMIENTAS (NATIVO):\n"
            "Tienes funciones integradas para modificar la base de datos. Úsalas directamente cuando el usuario pida cambios o necesites consultar datos.\n"
            "NO escribas bloques de código JSON en tus respuestas de texto. Si usas 'actualizar_calendario', espera a recibir la confirmación del sistema y luego confírmale al usuario amigablemente que el calendario se ha actualizado, mostrando la tabla si procede."
        )

        mensajes = [{"role": "system", "content": system_prompt}]
        
        # Historial rodante
        if mensaje.historial:
            for msg in mensaje.historial[-6:]:
                role = "assistant" if msg.rol == "ia" else "user"
                mensajes.append({"role": role, "content": msg.texto})
                
        mensajes.append({"role": "user", "content": mensaje.texto})

        # 5. El nuevo Bucle Nativo (Dejamos que la IA decida cuándo usar las herramientas)
        for _ in range(3):
            respuesta_ia = client.chat.completions.create(
                model="llama-3.3-70b-versatile", # Te recomiendo este modelo en Groq para un uso perfecto de herramientas
                messages=mensajes,
                tools=tools,
                tool_choice="auto",
                max_tokens=2048
            )
            
            msg_ia = respuesta_ia.choices[0].message
            
            # Convertimos el objeto a diccionario para poder añadirlo al historial de mensajes
            msg_dict = msg_ia.model_dump(exclude_unset=True)
            mensajes.append(msg_dict)
            
            # Si la IA no quiso usar ninguna herramienta, significa que ya tiene el texto final listo
            if not msg_ia.tool_calls:
                return {"respuesta": msg_ia.content or "Hecho."}
                
            # Si la IA usó una herramienta, la ejecutamos en Python
            for tool_call in msg_ia.tool_calls:
                func_name = tool_call.function.name
                args = json.loads(tool_call.function.arguments)
                
                if func_name == "consultar_calendario":
                    resultado = consultar_calendario()
                elif func_name == "actualizar_calendario":
                    resultado = actualizar_calendario(
                        objetivo=args.get("objetivo"),
                        fecha_meta=args.get("fecha_meta"),
                        sesiones=args.get("sesiones", [])
                    )
                else:
                    resultado = {"error": "Herramienta desconocida"}
                    
                # Le devolvemos el resultado a la IA para que continúe pensando
                mensajes.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "name": func_name,
                    "content": json.dumps(resultado)
                })
                
        # Si da 3 vueltas sin devolver texto (salvavidas)
        return {"respuesta": "He procesado los datos correctamente."}

    except Exception as e:
        return {"error_interno": f"Fallo en la matriz: {str(e)}"}

@app.get("/stats")
def obtener_estadisticas_dashboard(db: Session = Depends(get_db)):
    try:
        # Extraemos la última actividad sincronizada que tenga datos reales
        ultima_act = db.query(models.Activity).filter(
            models.Activity.icu_ctl.isnot(None)
        ).order_by(models.Activity.start_date_local.desc()).first()

        if not ultima_act:
            return {"error": "No hay suficientes datos. Sincroniza con Intervals.icu primero."}

        ctl = round(ultima_act.icu_ctl, 1)
        atl = round(ultima_act.icu_atl, 1)
        tsb = round(ctl - atl, 1)
        ftp = ultima_act.icu_ftp or 0 # Extraemos tu FTP real

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
            "ftp_actual": ftp, # Enviamos el FTP al frontend
            "explicacion_ia": response.choices[0].message.content
        }
    except Exception as e:
        return {"error": str(e)}

# Endpoint para la pestaña de Calendario
@app.get("/api/calendario")
def get_calendario(db: Session = Depends(get_db)):
    hoy = datetime.now().date()
    # Recuperamos los próximos 14 días de entrenamientos
    sesiones = db.query(models.EntrenamientoProgramado).filter(
        models.EntrenamientoProgramado.fecha_programada >= hoy
    ).order_by(models.EntrenamientoProgramado.fecha_programada.asc()).limit(14).all()
    
    return [
        {
            "id": s.id,
            "fecha": s.fecha_programada.strftime("%Y-%m-%d"),
            "sesion": s.tipo_sesion,
            "entorno": s.entorno,
            "duracion": s.duracion_minutos_planeada,
            "tss": s.tss_planeado,
            "estado": s.estado
        } for s in sesiones
    ]