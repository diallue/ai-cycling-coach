from fastapi import FastAPI, Depends, Response
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

@app.on_event("startup") if 'app' in locals() else None # Se inicializa abajo tras crear FastAPI
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

# 2. Configurar el nuevo cliente de Groq
client = Groq(api_key=os.getenv("GROQ_API_KEY"))

app = FastAPI(title="AI Cycling Coach API")

@app.on_event("startup")
def startup_db_seed():
    asegurar_usuario_inicial()

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
                                "description": "Lista de sesiones a programar. Si el usuario pide planificar o reestructurar la semana, envía todos los días ESTRICTAMENTE desde hoy hasta el domingo. Si pide modificar solo un día, envía únicamente ese día. NUNCA incluyas fechas anteriores a hoy.",
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
        
        # Calculamos la lista exacta de días permitidos (ej. si es domingo, solo sale el domingo)
        fechas_validas = [(hoy_dt + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(dias_hasta_domingo + 1)]
        fechas_validas_str = ", ".join(fechas_validas)
        
        system_prompt = (
            f"Hoy es {hoy_dt.strftime('%Y-%m-%d')}.\n"
            f"Eres el entrenador experto en ciclismo de Diego. Su FTP actual validado es de {ftp_actual}W.\n\n"
            
            "1. IDENTIDAD Y ADAPTABILIDAD:\n"
            "Eres una IA conversacional capaz de razonar sobre cualquier aspecto del ciclismo (fisiología, material, nutrición, táctica). "
            "Responde de forma natural, directa y experta a cualquier duda del usuario. Si pregunta cosas ajenas al deporte, reconduce la charla educadamente. "
            "NO asumas su objetivo. Si no lo sabes, llama a tu herramienta 'consultar_calendario' para leerlo de la base de datos, o pregúntaselo directamente para poder gestionar sub-objetivos y picos de forma.\n\n"
            
            "2. REGLA TEMPORAL (EL RESTO DE LA SEMANA):\n"
            "Cuando Diego te pida generar o reestructurar 'la semana', tu rango de acción es ESTRICTAMENTE desde HOY hasta el DOMINGO de esta semana. "
            "Si hoy es martes, planificarás de martes a domingo. Si hoy es domingo, solo planificarás el domingo. NUNCA generes, menciones ni sobrescribas entrenamientos en días pasados.\n\n"
            f"Las ÚNICAS fechas válidas para planificar o reestructurar 'esta semana' son ESTRICTAMENTE estas: [{fechas_validas_str}].\n"
            "TIENES TOTALMENTE PROHIBIDO generar, mencionar o programar entrenamientos para fechas que no estén en esa lista exacta. Si la lista solo contiene un día (hoy), SOLO reestructurarás ese único día.\n\n"
            
            "3. FORMATO INNEGOCIABLE PARA PLANIFICACIÓN:\n"
            "SOLO cuando el usuario pida explícitamente crear, ver o reestructurar un plan de entrenamiento, tu respuesta final DEBE seguir esta estructura visual (limitada estrictamente a los días que quedan en la semana):\n"
            "### 🗓 Planificación Semanal\n"
            "(Tabla Markdown: Día | Entorno | Duración | Sesión | TSS | Comentarios breves)\n\n"
            "### 🔬 Análisis Fisiológico y Ejecución\n"
            "(Desglose por día con pasos exactos y VATIOS calculados matemáticamente basándote SIEMPRE en su FTP actual de la base de datos).\n"
            "**Impacto Fisiológico:** Sistemas energéticos y adaptaciones generadas.\n\n"
            "### 💡 Pro-Tips del Coach\n"
            "(2 o 3 viñetas con estrategias de nutrición, hidratación o cadencia.)\n\n"
            
            "4. USO DE HERRAMIENTAS (NATIVO):\n"
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
                model="openai/gpt-oss-120b", # Te recomiendo este modelo en Groq para un uso perfecto de herramientas
                messages=mensajes,
                tools=tools,
                tool_choice="auto",
                max_tokens=4096
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
        # 1. Extraer historial para la gráfica (últimos 30 días)
        fecha_limite = datetime.now() - timedelta(days=30)
        historial = db.query(models.Activity).filter(
            models.Activity.icu_ctl.isnot(None),
            models.Activity.start_date_local >= fecha_limite
        ).order_by(models.Activity.start_date_local.asc()).all()

        # Fallback de seguridad si hay menos de 30 días registrados
        if not historial:
            ultima_act = db.query(models.Activity).filter(models.Activity.icu_ctl.isnot(None)).order_by(models.Activity.start_date_local.desc()).first()
            if not ultima_act:
                return {"error": "No hay suficientes datos. Sincroniza con Intervals.icu primero."}
            historial = [ultima_act]

        ultima_act = historial[-1] # La más reciente para los números grandes
        ctl = round(ultima_act.icu_ctl, 1)
        atl = round(ultima_act.icu_atl, 1)
        tsb = round(ctl - atl, 1)
        ftp = ultima_act.icu_ftp or 0 

        # 2. Formatear los arrays de datos para React Native
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
            "grafica_ctl": grafica_ctl,  # Enviamos la curva azul
            "grafica_atl": grafica_atl   # Enviamos la curva roja
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
            # EL CAMBIO CLAVE: Ahora mostramos el error exacto que nos devuelve Intervals
            return {"error": f"Error {response.status_code}: {response.text}"}

    except Exception as e:
        return {"error": str(e)}

@app.get("/api/exportar/archivo/{sesion_id}")
async def exportar_archivo_fit(sesion_id: int, db: Session = Depends(get_db)):
    try:
        sesion = db.query(models.EntrenamientoProgramado).filter(models.EntrenamientoProgramado.id == sesion_id).first()
        if not sesion:
            return {"error": "Sesión no encontrada"}

        # 1. Obtenemos el texto para la fábrica
        prompt = f"Convierte esta sesión para Intervals. Sesión: '{sesion.tipo_sesion}'. Reglas: Usa 'm' y '%'. Devuelve ÚNICAMENTE las líneas."
        respuesta_ia = client.chat.completions.create(model="openai/gpt-oss-20b", messages=[{"role": "user", "content": prompt}], max_tokens=500)
        workout_text = respuesta_ia.choices[0].message.content.strip()
        if workout_text.startswith("```"):
            workout_text = "\n".join(workout_text.split("\n")[1:-1]).strip()

        # 2. Lo subimos de forma temporal
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
            
            # 3. Pedimos el archivo .FIT compilado y lo devolvemos
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