from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Date, ForeignKey
from sqlalchemy.orm import relationship
from database import Base


class Usuario(Base):
    """Entidad central del ciclista con telemetría sincronizada desde Intervals.icu y disponibilidad persistente."""
    __tablename__ = "usuarios"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    nombre = Column(String, nullable=False)

    intervals_athlete_id = Column(String, nullable=True)
    intervals_api_key = Column(String, nullable=True)

    # Parámetros fisiológicos dinámicos sincronizados con Intervals.icu
    ftp_actual = Column(Integer, default=305)
    peso_actual = Column(Float, default=71.0)
    lthr = Column(Integer, default=178)
    max_hr = Column(Integer, default=200)
    w_prime = Column(Integer, nullable=True)

    # Memoria persistente de disponibilidad semanal (ej. "L-J=2h, V=0h, S-D=6h")
    disponibilidad_json = Column(String, nullable=True)

    actividades = relationship("Activity", back_populates="usuario")
    objetivos = relationship("Objetivo", back_populates="usuario")


class Activity(Base):
    __tablename__ = "activities"

    id = Column(String, primary_key=True, index=True)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False, default=1)

    name = Column(String)
    type = Column(String, index=True)
    start_date_local = Column(DateTime)

    moving_time = Column(Integer)
    distance = Column(Float, nullable=True)
    total_elevation_gain = Column(Float, nullable=True)

    tss = Column(Float, nullable=True)
    normalized_power = Column(Float, nullable=True)
    average_heartrate = Column(Float, nullable=True)
    icu_ftp = Column(Integer, nullable=True)
    icu_ctl = Column(Float, nullable=True)
    icu_atl = Column(Float, nullable=True)

    is_race = Column(Boolean, default=False)

    usuario = relationship("Usuario", back_populates="actividades")


class Objetivo(Base):
    """Soporta múltiples objetivos por temporada con prioridades A (principal), B (secundario) y C (preparatorio)."""
    __tablename__ = "objetivos"

    id = Column(Integer, primary_key=True, index=True)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False, default=1)

    nombre = Column(String, index=True)
    fecha_meta = Column(Date)
    prioridad = Column(String, default="A")          # "A", "B" o "C"
    tipo_evento = Column(String, nullable=True)      # Ej: "Everesting", "Gran Fondo", "XCO", "Etapas"
    detalles_evento = Column(String, nullable=True)  # Puerto, desnivel, distancia o exigencia
    disponibilidad_semanal = Column(String, nullable=True)
    activo = Column(Boolean, default=True)

    usuario = relationship("Usuario", back_populates="objetivos")
    entrenamientos = relationship("EntrenamientoProgramado", back_populates="objetivo")


class EntrenamientoProgramado(Base):
    """El calendario vivo con soporte para bloques estructurados JSON y conciliación automática con Intervals.icu."""
    __tablename__ = "entrenamientos_programados"

    id = Column(Integer, primary_key=True, index=True)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False, default=1)
    objetivo_id = Column(Integer, ForeignKey("objetivos.id"))

    fecha_programada = Column(Date, index=True)
    tipo_sesion = Column(String)
    entorno = Column(String)
    duracion_minutos_planeada = Column(Integer)
    tss_planeado = Column(Integer)

    estado = Column(String, default="Pendiente")
    motivo_adaptacion = Column(String, nullable=True)

    # Columna clave para almacenar la lista JSON de bloques diseñados por la IA
    estructura = Column(String, nullable=True)

    # Conciliación con actividades reales completadas en Intervals.icu
    tss_real = Column(Integer, nullable=True)
    actividad_completada_id = Column(String, nullable=True)

    objetivo = relationship("Objetivo", back_populates="entrenamientos")


class FaseMacrociclo(Base):
    """Cada uno de los bloques/mesociclos que componen la preparación hacia el Objetivo."""
    __tablename__ = "fases_macrociclo"

    id = Column(Integer, primary_key=True, index=True)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False, default=1)
    objetivo_id = Column(Integer, ForeignKey("objetivos.id"), nullable=False)

    orden = Column(Integer, nullable=False, default=1)
    nombre = Column(String, nullable=False)
    fecha_inicio = Column(Date, nullable=False)
    fecha_fin = Column(Date, nullable=False)
    descripcion = Column(String, nullable=False)
    foco_fisiologico = Column(String, nullable=True)
    resumen_estrategico = Column(String, nullable=True)