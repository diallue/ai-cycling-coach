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
        # Extraer tu FTP real de Intervals.icu
        act_con_ftp = db.query(models.Activity).filter(models.Activity.icu_ftp.isnot(None)).order_by(models.Activity.start_date_local.desc()).first()
        ftp_actual = act_con_ftp.icu_ftp if act_con_ftp else 200 # Vataje de seguridad si la BD está vacía

        # 1. Herramienta: Estado físico actual
        def obtener_estado_forma() -> dict:
            ultima_act = db.query(models.Activity).order_by(models.Activity.start_date_local.desc()).first()
            if not ultima_act or ultima_act.icu_ctl is None:
                return {"error": "No hay datos de fitness registrados aún."}
            return {
                "fecha": ultima_act.start_date_local.strftime("%Y-%m-%d"),
                "fitness_ctl": round(ultima_act.icu_ctl, 1),
                "fatiga_atl": round(ultima_act.icu_atl, 1),
                "frescura_tsb": round(ultima_act.icu_ctl - ultima_act.icu_atl, 1),
                "ftp_actual_w": ftp_actual
            }

        # 2. Herramienta: Generador de archivos ZWO
        def crear_entrenamiento_zwo(nombre: str, descripcion: str, bloques: list) -> dict:
            xml_content = workout_generator.generar_zwo(nombre, descripcion, bloques)
            os.makedirs("workouts", exist_ok=True)
            ruta = f"workouts/{nombre.replace(' ', '_').lower()}.zwo"
            with open(ruta, "w", encoding="utf-8") as f:
                f.write(xml_content)
            return {"resultado": f"Archivo generado en {ruta}."}

        # 3. Herramienta: Leer la agenda
        def consultar_calendario() -> dict:
            hoy = datetime.now().date()
            obj = db.query(models.Objetivo).filter(models.Objetivo.activo == True).first()
            if not obj:
                return {"aviso": "El usuario no tiene ningún objetivo ni plan activo."}

            sesiones = db.query(models.EntrenamientoProgramado).filter(
                models.EntrenamientoProgramado.objetivo_id == obj.id,
                models.EntrenamientoProgramado.fecha_programada >= hoy
            ).order_by(models.EntrenamientoProgramado.fecha_programada.asc()).limit(7).all()

            return {
                "objetivo": obj.nombre,
                "fecha_meta": str(obj.fecha_meta),
                "agenda": [
                    {
                        "fecha": str(s.fecha_programada),
                        "tipo": s.tipo_sesion,
                        "entorno": s.entorno,
                        "duracion_min": s.duracion_minutos_planeada,
                        "tss": s.tss_planeado,
                        "estado": s.estado,
                        "motivo": s.motivo_adaptacion
                    } for s in sesiones
                ]
            }

        # 4. Herramienta: Escribir/Modificar la agenda
        def actualizar_calendario(objetivo: str = None, fecha_meta: str = None, sesiones: list = []) -> dict:
            try:
                obj = db.query(models.Objetivo).filter(models.Objetivo.activo == True).first()
                if not obj:
                    # Valores de seguridad si la IA se olvida de mandar el objetivo en una reestructuración
                    nombre_seguro = objetivo if objetivo else "Preparación Everesting"
                    fecha_segura = fecha_meta if fecha_meta else "2026-12-31"
                    obj = models.Objetivo(nombre=nombre_seguro, fecha_meta=datetime.strptime(fecha_segura, "%Y-%m-%d").date())
                    db.add(obj)
                    db.commit()
                    db.refresh(obj)
                else:
                    if objetivo: obj.nombre = objetivo
                    if fecha_meta: obj.fecha_meta = datetime.strptime(fecha_meta, "%Y-%m-%d").date()

                for s in sesiones:
                    fecha_obj = datetime.strptime(s["fecha"], "%Y-%m-%d").date()
                    
                    # 1. Buscamos si ya hay un entrenamiento ese día exacto
                    sesion_db = db.query(models.EntrenamientoProgramado).filter(
                        models.EntrenamientoProgramado.fecha_programada == fecha_obj,
                        models.EntrenamientoProgramado.objetivo_id == obj.id
                    ).first()

                    # 2. Si no existe, lo creamos
                    if not sesion_db:
                        sesion_db = models.EntrenamientoProgramado(objetivo_id=obj.id, fecha_programada=fecha_obj)
                        db.add(sesion_db)

                    # 3. SOBRESCRIBIMOS todos los campos (esto aplica los cambios y los días de descanso)
                    sesion_db.tipo_sesion = s.get("tipo_sesion", "Descanso")
                    sesion_db.entorno = s.get("entorno", "Indoor")
                    # Usamos int() y un valor por defecto de 0 para evitar errores si la IA manda texto o un descanso
                    sesion_db.duracion_minutos_planeada = int(s.get("duracion_minutos", 0))
                    sesion_db.tss_planeado = int(s.get("tss", 0))
                    sesion_db.estado = s.get("estado", "Pendiente")
                    sesion_db.motivo_adaptacion = s.get("motivo", "Reestructuración")

                db.commit()
                return {"resultado": "El calendario se ha actualizado correctamente en la base de datos."}
            
            except Exception as e:
                # Si la IA manda un formato loco, deshacemos los cambios para no romper la BD
                db.rollback()
                return {"error_herramienta": f"Fallo al guardar en BD: {str(e)}"}

        # 5. Prompt de Sistema (Plantilla obligatoria, secuencia de pasos y protección JSON)
        hoy_dt = datetime.now()
        dias_hasta_domingo = 6 - hoy_dt.weekday() # 0 es Lunes, 6 es Domingo
        domingo_dt = hoy_dt + timedelta(days=dias_hasta_domingo)
        
        fecha_hoy_str = hoy_dt.strftime("%Y-%m-%d")
        fecha_domingo_str = domingo_dt.strftime("%Y-%m-%d")
        
        system_prompt = (
            f"Hoy es {fecha_hoy_str}. El domingo de esta semana es {fecha_domingo_str}. "
            f"Eres el entrenador experto en ciclismo de Diego. Su FTP actual validado en Intervals.icu es de {ftp_actual}W. "
            "REGLA DE FECHAS: Si Diego te pide un plan para 'esta semana', debes generar entrenamientos empezando ESTRICTAMENTE HOY y terminando el DOMINGO de esta semana. NUNCA programes sesiones en días anteriores a hoy.\n\n"
            "REGLA DE ORO 1: Calcula y redacta TODAS tus explicaciones de vatios, zonas e intensidades basándote estrictamente en este valor exacto.\n\n"
            "REGLA DE ORO 2 - SECUENCIA DE ACCIÓN: Si Diego te pide planificar, cambiar o reestructurar entrenamientos, DEBES hacerlo en 2 pasos obligatorios:\n"
            "PASO 1: Emite ÚNICAMENTE el bloque de código JSON con el comando 'actualizar_calendario' y las sesiones nuevas. NO añadas texto explicativo aquí.\n"
            "PASO 2: Cuando el sistema te devuelva un mensaje de éxito, ENTONCES redactarás tu respuesta final.\n\n"
            "REGLA DE ORO 3 - FORMATO FINAL: Tu respuesta final (el Paso 2) NO DEBE CONTENER JSON y debe seguir EXACTAMENTE esta estructura visual:\n"
            "### 🗓️ Planificación Semanal\n"
            "(Tabla Markdown limpia con las columnas EXACTAS: Día | Entorno | Duración | Sesión | TSS | Comentarios breves)\n\n"
            "### 🔬 Análisis Fisiológico y Ejecución\n"
            "(Desglosa CADA día de la tabla. Incluye:)\n"
            "- **Ejecución:** Pasos exactos y rangos de VATIOS calculados matemáticamente con el FTP.\n"
            "- **Impacto Fisiológico:** Sistemas energéticos y adaptaciones generadas.\n\n"
            "### 💡 Pro-Tips del Coach\n"
            "(2 o 3 viñetas con estrategias de nutrición, hidratación o cadencia.)\n\n"
            "REGLA CRÍTICA 4: ESTÁ TOTALMENTE PROHIBIDO usar llamadas a funciones nativas (tool calling). "
            "Para pedir datos a la base de datos, debes escribir texto normal que contenga un bloque Markdown exacto con la clave 'comando'.\n"
            "REGLA DE FORMATO JSON: El JSON debe ser estricto. NUNCA uses saltos de línea dentro de los valores de texto. CIERRA siempre todas las comillas dobles.\n\n"
            "Ejemplo para ver la agenda:\n"
            "```json\n{\"comando\": \"consultar_calendario\"}\n```\n\n"
            "Ejemplo para actualizar la agenda:\n"
            "```json\n{\"comando\": \"actualizar_calendario\", \"objetivo\": \"Everesting\", \"fecha_meta\": \"2026-11-15\", \"sesiones\": [{\"fecha\": \"2026-09-24\", \"tipo_sesion\": \"Rodillo 45m\", \"entorno\": \"Indoor\", \"duracion_minutos\": 45, \"tss\": 40, \"estado\": \"Pendiente\", \"motivo\": \"Lluvia\"}]}\n```\n"
            "REGLA DE ORO 5 - LÍMITE DE DOMINIO: Tu único propósito es la fisiología deportiva y tu objetivo es prepararme para mi objetivo. Si el usuario te hace preguntas sobre programación, política, recetas, o cualquier tema fuera del ciclismo o el entrenamiento de fuerza, DECLINA educadamente la respuesta y reconduce la conversación al entrenamiento.\n\n"
            "REGLA DE ORO 6: Si el atleta te pregunta '¿Cuál es mi objetivo?' o si dudas de cuál es su meta principal, NUNCA le devuelvas la pregunta. Emite inmediatamente el comando 'consultar_calendario' para extraer el objetivo guardado en la base de datos y confírmaselo."
        )

        mensajes = [{"role": "system", "content": system_prompt}]
        
        # Inyectar memoria a corto plazo (últimos 6 mensajes)
        if mensaje.historial:
            for msg in mensaje.historial[-6:]:
                role = "assistant" if msg.rol == "ia" else "user"
                mensajes.append({"role": role, "content": msg.texto})

        mensajes.append({"role": "user", "content": mensaje.texto})

        # 6. Bucle del Agente (Máximo 3 pasos: Consultar -> Actualizar -> Responder)
        for iteracion in range(3):
            try:
                # Intentamos obtener la respuesta normal de la IA
                respuesta_ia = client.chat.completions.create(
                    model="openai/gpt-oss-20b",
                    messages=mensajes,
                    max_tokens=4096
                )
                contenido = respuesta_ia.choices[0].message.content
                if contenido is None:
                    contenido = ""
                    
            except Exception as e:
                # RESCATE 2.0: Extraemos los datos nativos de la API sin recortar texto a mano
                if hasattr(e, 'response'):
                    try:
                        error_data = e.response.json()
                        failed_gen = error_data.get('error', {}).get('failed_generation')
                        
                        if failed_gen:
                            # Convertimos el string limpio a diccionario
                            datos_herramienta = json.loads(failed_gen)
                            argumentos = datos_herramienta.get("arguments", {})
                            
                            # Si la API envolvió los argumentos en texto, lo desencapsulamos
                            if isinstance(argumentos, str):
                                argumentos = json.loads(argumentos)
                                
                            # Empaquetamos el JSON perfecto para engañar a nuestro propio interceptor
                            contenido = f"```json\n{json.dumps(argumentos)}\n```"
                        else:
                            return {"error_interno": "Fallo desconocido en la API: " + str(error_data)}
                    except Exception as ex:
                        return {"error_interno": f"El modelo se enredó al calcular los días. Pídeselo de nuevo. Detalle técnico: {str(ex)}"}
                else:
                    return {"error_interno": str(e)}
            
            contenido = contenido.strip()

            # 7. Interceptor de herramientas por Markdown (Evita el bloqueo de la API y limpia errores)
            tool_result = None
            json_str = None
            
            if "```json" in contenido:
                inicio = contenido.find("```json") + 7
                fin = contenido.find("```", inicio)
                if fin != -1:
                    json_str = contenido[inicio:fin].strip()
                else:
                    json_str = contenido[inicio:].strip() # Por si el modelo olvidó cerrar los backticks
            elif "{" in contenido and "comando" in contenido:
                inicio = contenido.find("{")
                fin = contenido.rfind("}") + 1
                if inicio != -1 and fin != 0:
                    json_str = contenido[inicio:fin]

            if json_str:
                # LIMPIEZA CLAVE: Reemplaza saltos de línea accidentales por espacios para evitar el "Unterminated string"
                json_str = json_str.replace('\n', ' ').replace('\r', '')
                try:
                    data_accion = json.loads(json_str)
                    accion = data_accion.get("comando")
                    
                    if accion == "obtener_estado_forma":
                        tool_result = obtener_estado_forma()
                    elif accion == "consultar_calendario":
                        tool_result = consultar_calendario()
                    elif accion == "actualizar_calendario":
                        tool_result = actualizar_calendario(
                            objetivo=data_accion.get("objetivo"),
                            fecha_meta=data_accion.get("fecha_meta"),
                            sesiones=data_accion.get("sesiones", [])
                        )
                    elif accion == "crear_entrenamiento_zwo":
                        tool_result = crear_entrenamiento_zwo(
                            nombre=data_accion.get("nombre"),
                            descripcion=data_accion.get("descripcion"),
                            bloques=data_accion.get("bloques", [])
                        )
                except Exception as e:
                    tool_result = {"error_herramienta": str(e)}

            # 8. Decisión de flujo basada en las herramientas
            if tool_result is not None:
                mensajes.append({"role": "assistant", "content": contenido})
                
                # Instrucción condicional: Solo exigimos la tabla si realmente hemos modificado el calendario
                if accion == "actualizar_calendario":
                    instruccion_final = (
                        "La base de datos ha guardado los cambios con éxito. Ahora redacta tu respuesta final "
                        "siguiendo ESTRICTAMENTE la estructura visual de 3 bloques (Tabla con 'Comentarios breves', "
                        "Análisis con vatios y Pro-Tips). NO uses JSON en tu respuesta final."
                    )
                else:
                    instruccion_final = (
                        "Responde a la pregunta del atleta de forma conversacional, natural y directa usando estos datos. "
                        "NO uses la estructura de planificación semanal a menos que te pida crear o modificar un entrenamiento. "
                        "NO uses JSON."
                    )

                mensajes.append({
                    "role": "user", 
                    "content": f"Resultado del sistema: {json.dumps(tool_result)}. {instruccion_final}"
                })
            else:
                # Si no usó ninguna herramienta, significa que ya ha procesado los datos y esta es la respuesta final para el atleta.
                if not contenido:
                    return {"respuesta": "He realizado los ajustes, pero me he quedado sin palabras. Actualiza tu calendario."}
                
                # Aquí cortamos la función y enviamos la respuesta al móvil
                return {"respuesta": contenido}

        # 9. Si el bucle agota los 3 intentos sin devolver nada (salida de emergencia)
        return {"respuesta": "He procesado los datos de tu calendario. Revisa la pestaña de planificación para ver los detalles."}

    except Exception as e:
        return {"error_interno": str(e)}

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