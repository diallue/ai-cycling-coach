import xml.etree.ElementTree as ET
from xml.dom import minidom

def generar_zwo(nombre: str, descripcion: str, bloques: list) -> str:
    """
    Genera un archivo XML en formato .ZWO.
    Los simuladores basan la potencia en el % de FTP (ej: 1.0 = 100% FTP, 0.5 = 50% FTP).
    """
    workout_file = ET.Element("workout_file")
    
    ET.SubElement(workout_file, "author").text = "AI Cycling Coach"
    ET.SubElement(workout_file, "name").text = nombre
    ET.SubElement(workout_file, "description").text = descripcion
    ET.SubElement(workout_file, "sportType").text = "bike"
    
    workout = ET.SubElement(workout_file, "workout")
    
    for bloque in bloques:
        tipo = bloque.get("tipo")
        
        if tipo == "Warmup":
            ET.SubElement(workout, "Warmup", 
                          Duration=str(bloque["duracion_segundos"]), 
                          PowerLow=str(bloque["potencia_inicio"]), 
                          PowerHigh=str(bloque["potencia_fin"]))
                          
        elif tipo == "Cooldown":
            ET.SubElement(workout, "Cooldown", 
                          Duration=str(bloque["duracion_segundos"]), 
                          PowerLow=str(bloque["potencia_inicio"]), 
                          PowerHigh=str(bloque["potencia_fin"]))
                          
        elif tipo == "SteadyState":
            ET.SubElement(workout, "SteadyState", 
                          Duration=str(bloque["duracion_segundos"]), 
                          Power=str(bloque["potencia_inicio"]))
                          
        elif tipo == "IntervalsT":
            ET.SubElement(workout, "IntervalsT", 
                          Repeat=str(bloque["repeticiones"]),
                          OnDuration=str(bloque["duracion_on"]), 
                          OffDuration=str(bloque["duracion_off"]),
                          OnPower=str(bloque["potencia_on"]), 
                          OffPower=str(bloque["potencia_off"]))

    # Formatear el XML para que tenga saltos de línea y sangrías correctas
    xmlstr = minidom.parseString(ET.tostring(workout_file)).toprettyxml(indent="  ")
    return xmlstr