from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Date, ForeignKey
from sqlalchemy.orm import relationship
from database import Base

# --- NUEVO NÚCLEO MULTI-USUARIO ---

class Usuario(Base):
    """Entidad central para soportar múltiples usuarios en el futuro."""
    __tablename__ = "usuarios"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    nombre = Column(String, nullable=False)
    
    # Preparando el terreno para el paso 2 (credenciales individuales)
    intervals_athlete_id = Column(String, nullable=True)
    intervals_api_key = Column(String, nullable=True)
    ftp_actual = Column(Integer, default=200)

    # Relaciones bidireccionales
    actividades = relationship("Activity", back_populates="usuario")
    objetivos = relationship("Objetivo", back_populates="usuario")


# --- MODELOS ACTUALIZADOS CON CLAVE FORÁNEA ---

class Activity(Base):
    __tablename__ = "activities"

    # ID único que nos dará Intervals.icu
    id = Column(String, primary_key=True, index=True)
    
    # Pilar relacional: Cada actividad pertenece a un usuario (por defecto tú, id=1)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False, default=1)
    
    # Datos generales
    name = Column(String)
    type = Column(String, index=True) # Ej: 'Ride', 'VirtualRide', 'WeightTraining'
    start_date_local = Column(DateTime)
    
    # Métricas de carga y volumen
    moving_time = Column(Integer) # En segundos
    distance = Column(Float, nullable=True) # En metros
    total_elevation_gain = Column(Float, nullable=True) # Clave para medir desnivel
    
    # Métricas de intensidad fisiológica
    tss = Column(Float, nullable=True) # Training Stress Score
    normalized_power = Column(Float, nullable=True)
    average_heartrate = Column(Float, nullable=True)
    icu_ftp = Column(Integer, nullable=True) # El FTP que tenías ese día
    icu_ctl = Column(Float, nullable=True) # Fitness (Carga crónica)
    icu_atl = Column(Float, nullable=True) # Fatiga (Carga aguda)
    
    # Booleano útil para que la IA sepa si fue un test o carrera
    is_race = Column(Boolean, default=False)

    usuario = relationship("Usuario", back_populates="actividades")


class Objetivo(Base):
    """Define la meta final a largo plazo del macro-ciclo."""
    __tablename__ = "objetivos"

    id = Column(Integer, primary_key=True, index=True)
    
    # Pilar relacional
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False, default=1)
    
    nombre = Column(String, index=True) # ej: "Everesting"
    fecha_meta = Column(Date)
    activo = Column(Boolean, default=True)
    
    usuario = relationship("Usuario", back_populates="objetivos")
    entrenamientos = relationship("EntrenamientoProgramado", back_populates="objetivo")


class EntrenamientoProgramado(Base):
    """El calendario vivo. Cada día es una pieza que se puede mover o alterar."""
    __tablename__ = "entrenamientos_programados"

    id = Column(Integer, primary_key=True, index=True)
    
    # Pilar relacional
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False, default=1)
    
    objetivo_id = Column(Integer, ForeignKey("objetivos.id"))
    
    fecha_programada = Column(Date, index=True)
    tipo_sesion = Column(String)          # ej: "Fondo", "VO2Max", "SweetSpot", "Recuperación"
    entorno = Column(String)              # "Outdoor" o "Indoor (Rodillo)"
    duracion_minutos_planeada = Column(Integer)
    tss_planeado = Column(Integer)        # El estrés fisiológico que queremos lograr ese día
    
    # --- SISTEMA DE ADAPTACIÓN A LA VIDA REAL ---
    estado = Column(String, default="Pendiente") # Puede ser: Pendiente, Completado, Adaptado, Cancelado
    motivo_adaptacion = Column(String, nullable=True) # ej: "Lluvia", "Falta de tiempo", "Fatiga muscular"
    
    objetivo = relationship("Objetivo", back_populates="entrenamientos")