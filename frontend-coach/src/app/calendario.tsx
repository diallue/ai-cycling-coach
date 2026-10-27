import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Modal,
  Platform,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

const API_BASE = 'https://ai-cycling-coach-822a.onrender.com';
const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const COGGAN_ZONES = [
  { id: 'Z1', name: 'Recuperación Activa', minPct: 0, maxPct: 55, color: '#64748b', bgBadge: 'rgba(100,116,139,0.2)', desc: 'Regeneración muscular, flujo sanguíneo sin fatiga autonómica.' },
  { id: 'Z2', name: 'Resistencia Aeróbica', minPct: 56, maxPct: 75, color: '#0ea5e9', bgBadge: 'rgba(14,165,233,0.18)', desc: 'Base aeróbica, biogénesis mitocondrial y oxidación de grasas (FatMax).' },
  { id: 'Z3', name: 'Tempo / Sweet Spot', minPct: 76, maxPct: 90, color: '#10b981', bgBadge: 'rgba(16,185,129,0.18)', desc: 'Resistencia muscular aeróbica, incluye zona Sweet Spot (88-94%).' },
  { id: 'Z4', name: 'Umbral de Lactato (FTP)', minPct: 91, maxPct: 105, color: '#f59e0b', bgBadge: 'rgba(245,158,11,0.18)', desc: 'Máximo estado estable de lactato (MLSS) y aclaramiento.' },
  { id: 'Z5', name: 'VO2 Máximo', minPct: 106, maxPct: 120, color: '#f43f5e', bgBadge: 'rgba(244,63,94,0.18)', desc: 'Consumo máximo de oxígeno central y volumen sistólico cardíaco.' },
  { id: 'Z6', name: 'Capacidad Anaeróbica', minPct: 121, maxPct: 150, color: '#a855f7', bgBadge: 'rgba(168,85,247,0.18)', desc: 'Glucólisis anaeróbica, tolerancia a la acidosis y ataques largos.' },
  { id: 'Z7', name: 'Potencia Neuromuscular', minPct: 151, maxPct: 220, color: '#ec4899', bgBadge: 'rgba(236,72,153,0.18)', desc: 'Reclutamiento de fibras rápidas IIx y sprints puros.' },
];

const HR_ZONES = [
  { id: 'FC Z1', name: 'Recuperación Regenerativa', minLthrPct: 0, maxLthrPct: 81, color: '#94a3b8', desc: 'Rodaje muy suave de soltura' },
  { id: 'FC Z2', name: 'Base Aeróbica Extensiva', minLthrPct: 81, maxLthrPct: 89, color: '#38bdf8', desc: 'Fondo aeróbico todo el día (conversacional)' },
  { id: 'FC Z3', name: 'Tempo / Aeróbico Intensivo', minLthrPct: 90, maxLthrPct: 93, color: '#34d399', desc: 'Ritmo sostenido exigente y Sweet Spot' },
  { id: 'FC Z4', name: 'Sub-Umbral a Umbral (LTHR)', minLthrPct: 94, maxLthrPct: 99, color: '#fbbf24', desc: 'Entorno del pulso de umbral anaeróbico' },
  { id: 'FC Z5', name: 'VO2Máx y Zona Roja Máxima', minLthrPct: 100, maxLthrPct: 112, color: '#fb7185', desc: 'Por encima del umbral de lactato hasta FC Máx' },
];

const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DIAS_CORTO = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

function getZoneForFtpPct(pct: number) {
  if (pct <= 55) return COGGAN_ZONES[0];
  if (pct <= 75) return COGGAN_ZONES[1];
  if (pct <= 90) return COGGAN_ZONES[2];
  if (pct <= 105) return COGGAN_ZONES[3];
  if (pct <= 120) return COGGAN_ZONES[4];
  if (pct <= 150) return COGGAN_ZONES[5];
  return COGGAN_ZONES[6];
}

function obtenerRangoPotencia(pct: number, ftp: number) {
  const z = getZoneForFtpPct(pct);
  let minPct = Math.max(35, pct - 3);
  let maxPct = pct + 3;
  let subZona = z.id;

  if (pct <= 55) {
    minPct = 45;
    maxPct = 55;
    subZona = 'Z1 Recup';
  } else if (pct <= 64) {
    minPct = 56;
    maxPct = 65;
    subZona = 'Z2 Baja';
  } else if (pct <= 71) {
    minPct = 65;
    maxPct = 72;
    subZona = 'Z2 Media';
  } else if (pct <= 75) {
    minPct = 70;
    maxPct = 75;
    subZona = 'Z2 Alta';
  } else if (pct <= 82) {
    minPct = 76;
    maxPct = 83;
    subZona = 'Z3 Baja';
  } else if (pct <= 87) {
    minPct = 82;
    maxPct = 88;
    subZona = 'Z3 Tempo';
  } else if (pct <= 94) {
    minPct = 88;
    maxPct = 94;
    subZona = 'Sweet Spot';
  } else if (pct <= 100) {
    minPct = 95;
    maxPct = 100;
    subZona = 'Z4 Umbral';
  } else if (pct <= 105) {
    minPct = 100;
    maxPct = 105;
    subZona = 'Z4 Alta';
  } else if (pct <= 113) {
    minPct = 106;
    maxPct = 114;
    subZona = 'Z5 Media';
  } else if (pct <= 120) {
    minPct = 113;
    maxPct = 120;
    subZona = 'Z5 Alta';
  } else {
    minPct = pct - 5;
    maxPct = pct + 5;
    subZona = `${z.id} Potencia`;
  }

  const minW = Math.round(ftp * (minPct / 100));
  const maxW = Math.round(ftp * (maxPct / 100));

  return {
    ...z,
    subZona,
    minPct,
    maxPct,
    minW,
    maxW,
    rangoWatts: `${minW}-${maxW}W`,
    rangoPct: `${minPct}-${maxPct}%`,
  };
}

interface BloqueEntreno {
  type: 'steady' | 'interval';
  label: string;
  durationMin?: number;
  ftpPct?: number;
  cadence?: string;
  reps?: number;
  workMin?: number;
  workPct?: number;
  workCadence?: string;
  restMin?: number;
  restPct?: number;
}

function bloquesDesdeEstructura(raw: any): BloqueEntreno[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const num = (v: any, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const out: BloqueEntreno[] = [];
  raw.forEach((b: any) => {
    if (!b || typeof b !== 'object') return;
    const label = String(b.etiqueta || b.label || 'Bloque');
    const tipo = String(b.tipo || b.type || '').toLowerCase();
    if (tipo === 'intervalos' || tipo === 'interval' || b.repeticiones || b.reps) {
      out.push({
        type: 'interval',
        label,
        reps: Math.round(num(b.repeticiones || b.reps, 1)),
        workMin: num(b.trabajo_min || b.workMin, 5),
        workPct: num(b.trabajo_ftp_pct || b.workPct, 95),
        workCadence: String(b.trabajo_cadencia || b.workCadence || '90 rpm'),
        restMin: num(b.recuperacion_min || b.restMin, 3),
        restPct: num(b.recuperacion_ftp_pct || b.restPct, 55),
      });
    } else {
      out.push({
        type: 'steady',
        label,
        durationMin: num(b.duracion_min || b.durationMin, 10),
        ftpPct: num(b.ftp_pct || b.ftpPct, 65),
        cadence: String(b.cadencia || b.cadence || '90 rpm'),
      });
    }
  });
  return out.length > 0 ? out : null;
}

function construirEstructuraSesion(nombreSesion: string, duracionTotal: number, entorno: string, estructura?: any) {
  const texto = (nombreSesion || '').toLowerCase();
  const dur = Math.max(0, Number(duracionTotal) || 0);

  if (dur === 0 || texto.includes('descanso') || texto.includes('rest')) {
    return {
      isRest: true,
      coachNote: 'Día sin bicicleta para consolidar adaptaciones fisiológicas, reponer glucógeno muscular e hidratar bien.',
      blocks: [] as BloqueEntreno[],
    };
  }

  const bloquesCoach = bloquesDesdeEstructura(estructura);
  if (bloquesCoach) {
    return {
      isRest: false,
      coachNote: 'Sigue la estructura de bloques diseñada por tu entrenador.',
      blocks: bloquesCoach,
    };
  }

  const calMin = Math.max(8, Math.round(dur * 0.18));
  const enfMin = Math.max(5, Math.round(dur * 0.12));
  const cuerpoMin = Math.max(15, dur - calMin - enfMin);

  return {
    isRest: false,
    coachNote: 'Mantén una entrega de vatios constante entre el 65% y 72% del FTP sin picos en Z4.',
    blocks: [
      { type: 'steady', label: 'Calentamiento Progresivo', durationMin: calMin, ftpPct: 58, cadence: '88 rpm' },
      { type: 'steady', label: 'Bloque Aeróbico Continuo FatMax Z2', durationMin: cuerpoMin, ftpPct: 68, cadence: '88-92 rpm' },
      { type: 'steady', label: 'Enfriamiento Suave', durationMin: enfMin, ftpPct: 52, cadence: '85 rpm' },
    ] as BloqueEntreno[],
  };
}

function calcularMetricasSesion(sesionItem: any, ftp: number) {
  const estBase = construirEstructuraSesion(sesionItem.sesion, sesionItem.duracion, sesionItem.entorno, sesionItem.estructura);
  const zoneMinutes: Record<string, number> = { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 0, Z6: 0, Z7: 0 };

  let bloquesActivos: BloqueEntreno[] = estBase.blocks;
  const bloquesIA = bloquesDesdeEstructura(sesionItem.estructura);
  if (bloquesIA) {
    bloquesActivos = bloquesIA;
  }

  const esDescanso =
    (Number(sesionItem.duracion) || 0) === 0 ||
    (bloquesActivos.length === 0 && estBase.isRest);

  if (esDescanso) {
    return {
      isRest: true,
      durationMin: 0,
      np: 0,
      ifVal: 0,
      tss: 0,
      kj: 0,
      choPerHour: '0 g/h',
      choTotalGrams: 0,
      hydrationPerHour: 'Hidratación libre + electrolitos',
      coachNote: sesionItem.nota || estBase.coachNote,
      zoneMinutes,
      segments: [] as { label: string; durationMin: number; ftpPct: number; cadence: string }[],
      blocks: bloquesActivos,
    };
  }

  const segments: { label: string; durationMin: number; ftpPct: number; cadence: string }[] = [];
  bloquesActivos.forEach((b) => {
    if (b.type === 'interval') {
      const reps = b.reps || 1;
      for (let i = 1; i <= reps; i++) {
        segments.push({
          label: `${b.label} (#${i}/${reps})`,
          durationMin: b.workMin || 5,
          ftpPct: b.workPct || 95,
          cadence: b.workCadence || '90 rpm',
        });
        if ((b.restMin || 0) > 0) {
          segments.push({
            label: `Recuperación (#${i}/${reps})`,
            durationMin: b.restMin || 3,
            ftpPct: b.restPct || 55,
            cadence: '85 rpm',
          });
        }
      }
    } else {
      segments.push({
        label: b.label,
        durationMin: b.durationMin || 10,
        ftpPct: b.ftpPct || 68,
        cadence: b.cadence || '90 rpm',
      });
    }
  });

  let totalMinCalc = 0;
  let weightedFourthPower = 0;
  let totalKj = 0;

  segments.forEach((seg) => {
    const d = seg.durationMin;
    const watts = ftp * (seg.ftpPct / 100);
    totalMinCalc += d;
    weightedFourthPower += Math.pow(watts, 4) * d;
    totalKj += (watts * (d * 60)) / 1000;
    const z = getZoneForFtpPct(seg.ftpPct);
    zoneMinutes[z.id] += d;
  });

  const durationFinal = sesionItem.duracion || Math.round(totalMinCalc);
  const np = totalMinCalc > 0 ? Math.round(Math.pow(weightedFourthPower / totalMinCalc, 0.25)) : 0;
  const ifVal = ftp > 0 ? +(np / ftp).toFixed(2) : 0;
  const hours = durationFinal / 60;
  const tssCalc = Math.round(hours * Math.pow(ifVal, 2) * 100);
  const tssFinal = sesionItem.tss ? Number(sesionItem.tss) : tssCalc;
  const kj = Math.round(totalKj * (durationFinal / Math.max(1, totalMinCalc)));

  let choRate = 45;
  let choLabel = '40-50 g/h';
  let hydrationLabel = '600 ml/h (500mg Sodio)';

  if (durationFinal <= 55 && ifVal < 0.72) {
    choRate = 0;
    choLabel = '0-20 g/h (Sales)';
    hydrationLabel = '500 ml/h (400mg Sodio)';
  } else if (durationFinal > 140) {
    choRate = 85;
    choLabel = '80-90 g/h (Gut Training 1:0.8)';
    hydrationLabel = '750 ml/h (700mg Sodio)';
  } else if (ifVal >= 0.85 || durationFinal >= 90) {
    choRate = 70;
    choLabel = '60-80 g/h (Isotónico + Gel)';
    hydrationLabel = '700 ml/h (600mg Sodio)';
  }

  return {
    isRest: false,
    durationMin: durationFinal,
    np,
    ifVal,
    tss: tssFinal,
    kj,
    choPerHour: choLabel,
    choTotalGrams: Math.round(choRate * hours),
    hydrationPerHour: hydrationLabel,
    coachNote: sesionItem.nota || estBase.coachNote,
    zoneMinutes,
    segments,
    blocks: bloquesActivos,
  };
}

function formatMin(v: number) {
  const segundos = Math.round((v || 0) * 60);
  const mins = Math.floor(segundos / 60);
  const segs = segundos % 60;
  if (mins > 0 && segs > 0) return `${mins}m${segs}s`;
  return mins > 0 ? `${mins}m` : `${segs}s`;
}

function formatDurationHm(totalMinutes: number) {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m < 10 ? '0' + m : m}m`;
}

export default function CalendarioScreen() {
  const [sesiones, setSesiones] = useState<any[]>([]);
  const [sincronizando, setSincronizando] = useState(false);

  const [telemetria, setTelemetria] = useState<any>({
    ftp: 305,
    peso: 71.0,
    lthr: 178,
    max_hr: 200,
    objetivo: 'Sin objetivo definido',
    rest_or_train: {
      score: 78,
      veredicto: 'TRAIN HARD',
      color: '#10b981',
      acwr: 1.0,
      consejo: 'Estado óptimo para entrenar.',
    },
  });
  const [cargando, setCargando] = useState(true);

  const [selector, setSelector] = useState({ visible: false, id: 0, nombre: '' });
  const [zonesModalVisible, setZonesModalVisible] = useState(false);
  const [detalleId, setDetalleId] = useState<number | null>(null);
  const [analiticaAbierta, setAnaliticaAbierta] = useState(false);

  const cargarCalendario = useCallback(async () => {
    try {
      const timestamp = new Date().getTime();
      const url = `${API_BASE}/api/calendario?t=${timestamp}`;
      const respuesta = await fetch(url, {
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', Expires: '0' },
      });
      if (!respuesta.ok) return;
      const data = await respuesta.json();

      if (Array.isArray(data)) {
        setSesiones(data);
      } else if (data && Array.isArray(data.sesiones)) {
        setSesiones(data.sesiones);
        if (data.telemetria) {
          setTelemetria((prev: any) => ({ ...prev, ...data.telemetria }));
        }
      }
    } catch (error) {
      console.error('Error cargando calendario:', error);
    } finally {
      setCargando(false);
    }
  }, []);

  const sincronizarTodoConIntervals = async () => {
    setSincronizando(true);
    try {
      await fetch(`${API_BASE}/sync`, { method: 'POST' });
      await cargarCalendario();
    } catch (e) {
      console.error('Error sincronizando:', e);
    } finally {
      setSincronizando(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      cargarCalendario();
    }, [cargarCalendario])
  );

  const toggleCompletado = async (id: number) => {
    try {
      setSesiones((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, estado: s.estado === 'Completado' ? 'Pendiente' : 'Completado' } : s
        )
      );
      await fetch(`${API_BASE}/api/calendario/toggle/${id}`, { method: 'POST' });
    } catch (error) {
      console.error('Error al actualizar estado:', error);
    }
  };

  const adaptarHoyCheckin = async (sensacion: string, minutos: number, entornoElegido: string) => {
    try {
      setCargando(true);
      const res = await fetch(`${API_BASE}/api/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sensacion_piernas: sensacion,
          minutos_disponibles: minutos,
          entorno: entornoElegido,
        }),
      });
      if (res.ok) {
        await cargarCalendario();
        Alert.alert('Sesión de Hoy Adaptada ⚡', `Recalculada a ${minutos} min (${sensacion}).`);
      }
    } catch {
      Alert.alert('Error', 'Fallo al enviar el check-in.');
    } finally {
      setCargando(false);
    }
  };

  const sincronizarNube = async (id: number) => {
    try {
      Alert.alert('Enviando...', 'Sincronizando por el aire con tu ciclocomputador ☁️');
      const url = `${API_BASE}/api/exportar/nube/${id}`;
      const respuesta = await fetch(url, { method: 'POST' });
      const data = await respuesta.json();

      if (data.status === 'success') {
        Alert.alert('¡Entrenamiento listo! 🚀', 'El entrenamiento aparecerá en tu ciclocomputador automáticamente.');
      } else {
        Alert.alert('Error', data.error || 'Fallo al conectar con la nube.');
      }
    } catch {
      Alert.alert('Error de Red', 'No se ha podido contactar con el servidor.');
    }
  };

  const descargarArchivoFIT = async (id: number, nombre: string) => {
    try {
      Alert.alert('Generando...', 'Construyendo archivo universal .FIT...');
      const nombreLimpio = nombre.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const fileUri = `${FileSystem.documentDirectory}${nombreLimpio}.fit`;
      const url = `${API_BASE}/api/exportar/archivo/${id}`;

      const { uri } = await FileSystem.downloadAsync(url, fileUri);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/vnd.ant.fit',
          dialogTitle: 'Exportar entrenamiento (.FIT)',
        });
      }
    } catch {
      Alert.alert('Error', 'Fallo al descargar el archivo.');
    }
  };

  const resumenMicrociclo = useMemo(() => {
    const ftp = telemetria.ftp;
    let totalPlannedTss = 0;
    let totalCompletedTss = 0;
    let totalPlannedMin = 0;
    let totalCompletedMin = 0;
    let totalKj = 0;
    let totalChoGrams = 0;
    let weightedNpSum = 0;
    let activeSessionsCount = 0;
    let completedSessionsCount = 0;

    const weeklyZonesMin: Record<string, number> = { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 0, Z6: 0, Z7: 0 };

    const sesionesEnriquecidas = sesiones.map((s) => {
      const m = calcularMetricasSesion(s, ftp);
      const isCompleted = s.estado === 'Completado' || Boolean(s.actividad_real);

      if (!m.isRest) {
        activeSessionsCount++;
        totalPlannedTss += m.tss;
        totalPlannedMin += m.durationMin;
        totalKj += m.kj;
        totalChoGrams += m.choTotalGrams;
        weightedNpSum += m.np * m.durationMin;

        Object.keys(weeklyZonesMin).forEach((zKey) => {
          weeklyZonesMin[zKey] += m.zoneMinutes[zKey] || 0;
        });

        if (isCompleted) {
          completedSessionsCount++;
          totalCompletedTss += s.tss_real || m.tss;
          totalCompletedMin += s.actividad_real?.duracion_min || m.durationMin;
        }
      }
      return { ...s, metrics: m, isCompleted };
    });

    const avgNp = totalPlannedMin > 0 ? Math.round(weightedNpSum / totalPlannedMin) : 0;
    const avgIf = ftp > 0 && avgNp > 0 ? (avgNp / ftp).toFixed(2) : '0.00';
    const compliancePct = totalPlannedTss > 0 ? Math.min(100, Math.round((totalCompletedTss / totalPlannedTss) * 100)) : 0;

    const totalZ = Math.max(1, totalPlannedMin);
    const lowPct = Math.round(((weeklyZonesMin.Z1 + weeklyZonesMin.Z2) / totalZ) * 100);
    const midPct = Math.round(((weeklyZonesMin.Z3 + weeklyZonesMin.Z4) / totalZ) * 100);
    const highPct = Math.max(0, 100 - lowPct - midPct);

    let modeloDist = 'Distribución Piramidal';
    if (lowPct >= 72 && highPct > midPct) modeloDist = 'Distribución Polarizada (80/20)';
    else if (midPct >= 32) modeloDist = 'Específico Sweet Spot / Umbral';

    return {
      sesionesEnriquecidas,
      totalPlannedTss,
      totalCompletedTss,
      totalPlannedMin,
      totalCompletedMin,
      totalKj,
      totalChoGrams,
      avgNp,
      avgIf,
      compliancePct,
      activeSessionsCount,
      completedSessionsCount,
      weeklyZonesMin,
      lowPct,
      midPct,
      highPct,
      modeloDist,
    };
  }, [sesiones, telemetria.ftp]);

  const wkg = (telemetria.ftp / (telemetria.peso || 71)).toFixed(2);
  const rt = telemetria.rest_or_train || {
    score: 78,
    veredicto: 'TRAIN HARD',
    color: '#10b981',
    acwr: 1.0,
    consejo: 'Estado óptimo para entrenar.',
  };

  const sesionDetalle =
    detalleId !== null
      ? resumenMicrociclo.sesionesEnriquecidas.find((s) => s.id === detalleId) ?? null
      : null;

  const abrirSelectorExportacion = (item: any) => {
    setDetalleId(null);
    setTimeout(() => setSelector({ visible: true, id: item.id, nombre: item.sesion }), 350);
  };

  const renderDetalleSesion = (item: any) => {
    const m = item.metrics;
    const fechaObj = new Date(`${item.fecha}T00:00:00`);
    const nombreDia = !isNaN(fechaObj.getTime()) ? DIAS_SEMANA[fechaObj.getDay()] : '';
    const isIndoor = (item.entorno || '').toLowerCase().includes('indoor');

    return (
      <View style={[styles.modalSheet, { maxHeight: '88%' }]}>
        <View style={styles.modalHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.dayNameText}>
              {nombreDia} • {item.fecha}
            </Text>
            <Text style={[styles.modalTitle, { marginTop: 3 }]}>{item.sesion}</Text>
            <Text style={styles.modalSubheader}>
              {m.isRest
                ? '🛌 Descanso'
                : `${isIndoor ? '⚡ Rodillo Indoor' : '🛣️ Exterior'} • ${formatDurationHm(m.durationMin)} • ${m.tss} TSS`}
            </Text>
          </View>
          <TouchableOpacity style={styles.closeIconBtn} onPress={() => setDetalleId(null)}>
            <Text style={{ color: '#cbd5e1', fontWeight: 'bold' }}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={{ marginTop: 14 }} showsVerticalScrollIndicator={false}>
          {item.actividad_real && (
            <View style={styles.realActivityBanner}>
              <Text style={styles.realActivityTitle}>
                ✅ SALIDA REAL REGISTRADA: {item.actividad_real.nombre}
              </Text>
              <Text style={styles.realActivitySub}>
                ⏱️ {formatDurationHm(item.actividad_real.duracion_min)} • 📍 {item.actividad_real.distancia_km} km • ⛰️ +{item.actividad_real.desnivel_m} m • ⚡ NP {item.actividad_real.np}W • 🔥 {item.actividad_real.tss} TSS
              </Text>
            </View>
          )}

          <View style={styles.coachNoteCard}>
            <Text style={styles.coachNoteCardTitle}>🎙️ Nota del entrenador</Text>
            <Text style={styles.coachNoteCardText}>{m.coachNote}</Text>
          </View>

          {!m.isRest && (
            <>
              <Text style={[styles.sectionMiniTitle, { marginTop: 18, marginBottom: 8 }]}>
                ESTRUCTURA DE LA SESIÓN
              </Text>

              <View style={{ gap: 6 }}>
                {m.blocks.map((b: BloqueEntreno, bIdx: number) => {
                  if (b.type === 'interval') {
                    const rangoTrabajo = obtenerRangoPotencia(b.workPct || 95, telemetria.ftp);
                    const rangoRecup = obtenerRangoPotencia(b.restPct || 55, telemetria.ftp);

                    return (
                      <View key={bIdx} style={styles.stepRow}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                          <View
                            style={[
                              styles.stepZoneTag,
                              { backgroundColor: rangoTrabajo.bgBadge, borderColor: rangoTrabajo.color },
                            ]}
                          >
                            <Text style={[styles.stepZoneTagText, { color: rangoTrabajo.color }]}>
                              {rangoTrabajo.subZona}
                            </Text>
                          </View>
                          <Text style={styles.stepRepsText}>{b.reps}x</Text>
                          <Text style={styles.stepLabelText} numberOfLines={1}>
                            {b.label}
                          </Text>
                        </View>
                        <Text style={styles.stepWattsInterval}>
                          {formatMin(b.workMin || 0)} a {rangoTrabajo.rangoWatts} ({rangoTrabajo.rangoPct}) • {b.workCadence}
                        </Text>
                        <Text style={styles.stepRecupText}>
                          ↳ Recup: {formatMin(b.restMin || 0)} a {rangoRecup.rangoWatts} ({rangoRecup.rangoPct})
                        </Text>
                      </View>
                    );
                  }

                  const rango = obtenerRangoPotencia(b.ftpPct || 65, telemetria.ftp);
                  return (
                    <View key={bIdx} style={styles.stepRow}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                        <View
                          style={[
                            styles.stepZoneTag,
                            { backgroundColor: rango.bgBadge, borderColor: rango.color },
                          ]}
                        >
                          <Text style={[styles.stepZoneTagText, { color: rango.color }]}>{rango.subZona}</Text>
                        </View>
                        <Text style={styles.stepLabelText} numberOfLines={1}>
                          {b.label}
                        </Text>
                      </View>
                      <Text style={styles.stepWattsSteady}>
                        {b.durationMin} min a {rango.rangoWatts} ({rango.rangoPct}) • {b.cadence}
                      </Text>
                    </View>
                  );
                })}
              </View>

              <Text style={[styles.hydrationText, { marginTop: 14 }]}>💧 {m.hydrationPerHour}</Text>

              <TouchableOpacity style={styles.exportBtn} onPress={() => abrirSelectorExportacion(item)}>
                <Text style={styles.exportBtnText}>🚀 Exportar entrenamiento al ciclocomputador</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </View>
    );
  };

  if (cargando && sesiones.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#10b981" />
        <Text style={styles.loadingText}>Sincronizando agenda semanal...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* ==================== CABECERA COMPACTA Y LIMPIA ==================== */}
      <View style={styles.navbar}>
        <View style={styles.brandRow}>
          <View style={styles.brandIcon}>
            <Text style={{ fontSize: 18 }}>🚴‍♂️</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.brandTitle}>
              AGENDA <Text style={{ color: '#34d399' }}>SEMANAL</Text>
            </Text>
            <Text style={styles.brandSubtitle} numberOfLines={1}>
              🎯 {telemetria.objetivo} • {telemetria.ftp}W ({wkg} W/kg)
            </Text>
          </View>
          <TouchableOpacity style={styles.zonesBtn} onPress={() => setZonesModalVisible(true)}>
            <Text style={styles.zonesBtnText}>⚡ Zonas Z1-Z7</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={sincronizando} onRefresh={sincronizarTodoConIntervals} tintColor="#10b981" />}
      >
        {/* ==================== TARJETA INTEGRADA: READINESS + CHECK-IN RÁPIDO (SIN CORTES) ==================== */}
        <View style={[styles.restOrTrainCard, { borderColor: rt.color }]}>
          <View style={styles.rtTopRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
              <View style={[styles.rtIndicatorDot, { backgroundColor: rt.color }]} />
              <Text style={styles.rtOverline} numberOfLines={1}>
                READINESS HOY
              </Text>
            </View>
            <View style={[styles.rtVerdictBadge, { backgroundColor: `${rt.color}22`, borderColor: rt.color }]}>
              <Text style={[styles.rtVerdictText, { color: rt.color }]}>
                {rt.veredicto} ({rt.score}%)
              </Text>
            </View>
          </View>

          <Text style={styles.rtAdviceText}>{rt.consejo}</Text>

          <View style={styles.checkinBar}>
            <TouchableOpacity
              style={[styles.checkinBtn, { backgroundColor: 'rgba(16,185,129,0.12)', borderColor: '#10b981' }]}
              onPress={() => adaptarHoyCheckin('frescas', 90, 'Indoor')}
            >
              <Text style={[styles.checkinBtnText, { color: '#34d399' }]}>⚡ 1.5h Fresco</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.checkinBtn, { backgroundColor: 'rgba(14,165,233,0.12)', borderColor: '#0ea5e9' }]}
              onPress={() => adaptarHoyCheckin('normales', 60, 'Indoor')}
            >
              <Text style={[styles.checkinBtnText, { color: '#38bdf8' }]}>⏱️ Tengo 1h Hoy</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.checkinBtn, { backgroundColor: 'rgba(244,63,94,0.12)', borderColor: '#f43f5e' }]}
              onPress={() => adaptarHoyCheckin('cargadas', 50, 'Indoor')}
            >
              <Text style={[styles.checkinBtnText, { color: '#fb7185' }]}>🦵 Fatiga (Z1)</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ==================== RESUMEN COMPACTO DEL MICROCICLO (DESPLEGABLE) ==================== */}
        <View style={styles.dashboardPanel}>
          <TouchableOpacity
            style={[
              styles.dashboardHeader,
              !analiticaAbierta && { borderBottomWidth: 0, paddingBottom: 0 },
            ]}
            activeOpacity={0.8}
            onPress={() => setAnaliticaAbierta((v) => !v)}
          >
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={styles.panelTitle}>Carga de la Semana</Text>
                <View style={styles.modelBadge}>
                  <Text style={styles.modelBadgeText}>{resumenMicrociclo.modeloDist}</Text>
                </View>
              </View>
              <Text style={styles.panelSubtitle}>
                TSS {resumenMicrociclo.totalCompletedTss}/{resumenMicrociclo.totalPlannedTss} • {formatDurationHm(resumenMicrociclo.totalPlannedMin)} • IF {resumenMicrociclo.avgIf}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <View style={styles.complianceBadge}>
                <Text style={styles.complianceBadgeText}>
                  {resumenMicrociclo.compliancePct}% ({resumenMicrociclo.completedSessionsCount}/{resumenMicrociclo.activeSessionsCount})
                </Text>
              </View>
              <Text style={styles.analiticaToggleText}>{analiticaAbierta ? 'Ocultar ▴' : 'Detalles ▾'}</Text>
            </View>
          </TouchableOpacity>

          {!analiticaAbierta && (
            <View style={[styles.progressTrack, { marginTop: 8 }]}>
              <View style={[styles.progressFill, { width: `${resumenMicrociclo.compliancePct}%` }]} />
            </View>
          )}

          {analiticaAbierta && (
            <View style={styles.kpiGrid}>
              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel}>🔥 TSS SEMANAL</Text>
                <Text style={styles.kpiMainVal}>{resumenMicrociclo.totalPlannedTss} TSS</Text>
                <Text style={[styles.kpiSub, { color: '#34d399' }]}>
                  Hecho: {resumenMicrociclo.totalCompletedTss} TSS
                </Text>
              </View>
              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel}>⏱️ VOLUMEN TOTAL</Text>
                <Text style={styles.kpiMainVal}>{formatDurationHm(resumenMicrociclo.totalPlannedMin)}</Text>
                <Text style={[styles.kpiSub, { color: '#38bdf8' }]}>
                  Hecho: {formatDurationHm(resumenMicrociclo.totalCompletedMin)}
                </Text>
              </View>
              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel}>🔋 TRABAJO MEC.</Text>
                <Text style={styles.kpiMainVal}>{resumenMicrociclo.totalKj} kJ</Text>
                <Text style={styles.kpiSub}>NP Media: {resumenMicrociclo.avgNp}W</Text>
              </View>
              <View style={styles.kpiCard}>
                <Text style={[styles.kpiLabel, { color: '#fbbf24' }]}>🍼 NUTRICIÓN CHO</Text>
                <Text style={[styles.kpiMainVal, { color: '#fbbf24' }]}>{resumenMicrociclo.totalChoGrams} g</Text>
                <Text style={styles.kpiSub}>60-90 g/h en ruta</Text>
              </View>
            </View>
          )}
        </View>

        {/* ==================== LISTA DE ENTRENAMIENTOS SEMANALES ==================== */}
        {resumenMicrociclo.sesionesEnriquecidas.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>Sin sesiones activas esta semana</Text>
            <Text style={styles.emptyText}>
              Abre la pestaña Coach y pídele que planifique tu semana según tu bloque activo.
            </Text>
          </View>
        ) : (
          resumenMicrociclo.sesionesEnriquecidas.map((item, idx) => {
            const m = item.metrics;
            const fechaObj = new Date(`${item.fecha}T00:00:00`);
            const diaIdx = !isNaN(fechaObj.getTime()) ? fechaObj.getDay() : idx % 7;
            const nombreDia = DIAS_SEMANA[diaIdx];
            const letraDia = DIAS_CORTO[diaIdx];
            const isIndoor = (item.entorno || '').toLowerCase().includes('indoor');

            const maxPctBar = Math.max(130, ...m.segments.map((s: any) => s.ftpPct || 70));
            const ftpLineBottomPct = Math.min(92, Math.round((100 / maxPctBar) * 100));

            return (
              <TouchableOpacity
                key={item.id.toString()}
                activeOpacity={0.85}
                onPress={() => setDetalleId(item.id)}
                style={[
                  styles.workoutCard,
                  item.isCompleted && styles.workoutCardCompleted,
                ]}
              >
                <View style={styles.cardTopBar}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                    <View
                      style={[
                        styles.dayAvatar,
                        item.isCompleted
                          ? styles.dayAvatarCompleted
                          : m.isRest
                            ? styles.dayAvatarRest
                            : styles.dayAvatarActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.dayAvatarShort,
                          item.isCompleted && { color: '#020617' },
                        ]}
                      >
                        {letraDia}
                      </Text>
                      <Text
                        style={[
                          styles.dayAvatarNum,
                          item.isCompleted && { color: '#020617' },
                        ]}
                      >
                        D{idx + 1}
                      </Text>
                    </View>

                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Text style={styles.dayNameText}>
                          {nombreDia} • {item.fecha}
                        </Text>
                        <View
                          style={[
                            styles.envBadge,
                            m.isRest
                              ? styles.envRest
                              : isIndoor
                                ? styles.envIndoor
                                : styles.envOutdoor,
                          ]}
                        >
                          <Text
                            style={[
                              styles.envBadgeText,
                              m.isRest
                                ? { color: '#94a3b8' }
                                : isIndoor
                                  ? { color: '#fcd34d' }
                                  : { color: '#7dd3fc' },
                            ]}
                          >
                            {m.isRest ? '🛌 Descanso' : isIndoor ? '⚡ Rodillo Indoor' : '🛣️ Exterior'}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.workoutTitleText}>{item.sesion}</Text>
                    </View>
                  </View>

                  {!m.isRest && (
                    <TouchableOpacity
                      style={[
                        styles.doneBtn,
                        item.isCompleted && styles.doneBtnActive,
                      ]}
                      onPress={() => toggleCompletado(item.id)}
                    >
                      <Text
                        style={[
                          styles.doneBtnText,
                          item.isCompleted && { color: '#020617' },
                        ]}
                      >
                        {item.isCompleted ? '✓ Hecho' : 'Marcar'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>

                {item.actividad_real && (
                  <View style={styles.matchedActivityStrip}>
                    <Text style={styles.matchedActivityText}>
                      🚴‍♂️ Completado: {item.actividad_real.nombre} • {item.actividad_real.distancia_km} km • +{item.actividad_real.desnivel_m}m • {item.actividad_real.np}W NP • {item.actividad_real.tss} TSS
                    </Text>
                  </View>
                )}

                {!m.isRest ? (
                  <>
                    <View style={styles.telemetryStrip}>
                      <View style={styles.stripMetricsRow}>
                        <Text style={styles.stripItem}>
                          <Text style={styles.stripLabel}>Dur: </Text>
                          <Text style={styles.stripValWhite}>{formatDurationHm(m.durationMin)}</Text>
                        </Text>
                        <Text style={styles.stripItem}>
                          <Text style={styles.stripLabel}>TSS: </Text>
                          <Text style={{ color: '#fbbf24', fontWeight: '800' }}>
                            {item.tss_real ? `${item.tss_real}/${m.tss}` : m.tss}
                          </Text>
                        </Text>
                        <Text style={styles.stripItem}>
                          <Text style={styles.stripLabel}>IF: </Text>
                          <Text style={{ color: '#34d399', fontWeight: '800' }}>{m.ifVal}</Text>
                        </Text>
                        <Text style={styles.stripItem}>
                          <Text style={styles.stripLabel}>NP: </Text>
                          <Text style={{ color: '#38bdf8', fontWeight: '800' }}>{m.np}W</Text>
                        </Text>
                      </View>
                      <View style={styles.choBadge}>
                        <Text style={styles.choBadgeText}>⚡ {m.choPerHour}</Text>
                      </View>
                    </View>

                    <View style={styles.cardBody}>
                      <View style={styles.powerChartBox}>
                        <View
                          style={[
                            styles.ftpReferenceLine,
                            { bottom: `${ftpLineBottomPct}%` },
                          ]}
                        >
                          <Text style={styles.ftpReferenceLabel}>FTP {telemetria.ftp}W</Text>
                        </View>
                        <View style={styles.barsRow}>
                          {m.segments.map((seg: any, sIdx: number) => {
                            const heightPct = Math.max(
                              12,
                              Math.min(100, Math.round((seg.ftpPct / maxPctBar) * 100))
                            );
                            const z = getZoneForFtpPct(seg.ftpPct);
                            return (
                              <View
                                key={sIdx}
                                style={{
                                  flex: Math.max(1, seg.durationMin),
                                  height: `${heightPct}%`,
                                  backgroundColor: z.color,
                                  borderRadius: 3,
                                  marginHorizontal: 1,
                                }}
                              />
                            );
                          })}
                        </View>
                      </View>

                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                        <Text style={[styles.origenEstructuraText, { color: '#34d399', marginTop: 0 }]}>
                          ✔ Bloques estructurados por el coach
                        </Text>
                        <Text style={styles.tapHintText}>Ver vatios y exportar ›</Text>
                      </View>
                    </View>
                  </>
                ) : (
                  <View style={styles.restBody}>
                    <Text style={styles.restSubText}>Día sin bici • Toca para ver la nota del entrenador</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* MODAL LABORATORIO DE ZONAS Z1-Z7 */}
      <Modal visible={zonesModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { maxHeight: '88%' }]}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>⚡ Zonas Coggan Z1-Z7 y FC</Text>
                <Text style={styles.modalSubheader}>
                  FTP: {telemetria.ftp}W ({wkg} W/kg) • LTHR: {telemetria.lthr} bpm • FC Máx: {telemetria.max_hr} bpm
                </Text>
              </View>
              <TouchableOpacity style={styles.closeIconBtn} onPress={() => setZonesModalVisible(false)}>
                <Text style={{ color: '#cbd5e1', fontWeight: 'bold' }}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={{ marginTop: 12 }} showsVerticalScrollIndicator={false}>
              <Text style={styles.zoneSectionHeader}>🔥 7 ZONAS DE POTENCIA (COGGAN)</Text>
              {COGGAN_ZONES.map((z) => {
                const minW = Math.round(telemetria.ftp * (z.minPct / 100));
                const maxW = Math.round(telemetria.ftp * (z.maxPct / 100));
                const rangeStr = z.id === 'Z1' ? `< ${maxW}W` : z.id === 'Z7' ? `> ${minW}W` : `${minW} - ${maxW}W`;
                return (
                  <View key={z.id} style={styles.zoneModalRow}>
                    <View style={[styles.stepZoneTag, { backgroundColor: z.bgBadge, borderColor: z.color }]}>
                      <Text style={[styles.stepZoneTagText, { color: z.color }]}>{z.id}</Text>
                    </View>
                    <View style={{ flex: 1, marginHorizontal: 10 }}>
                      <Text style={styles.zoneModalName}>{z.name}</Text>
                      <Text style={styles.zoneModalDesc}>{z.desc}</Text>
                    </View>
                    <Text style={styles.zoneModalWatts}>{rangeStr}</Text>
                  </View>
                );
              })}

              <Text style={[styles.zoneSectionHeader, { color: '#fb7185', marginTop: 18 }]}>
                ❤️ 5 ZONAS DE FRECUENCIA CARDÍACA (LTHR)
              </Text>
              {HR_ZONES.map((hz) => {
                const minBpm = hz.minLthrPct === 0 ? Math.round(telemetria.lthr * 0.55) : Math.round(telemetria.lthr * (hz.minLthrPct / 100));
                const maxBpm = hz.id === 'FC Z5' ? telemetria.max_hr : Math.round(telemetria.lthr * (hz.maxLthrPct / 100));
                return (
                  <View key={hz.id} style={styles.zoneModalRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.zoneModalName, { color: hz.color }]}>
                        {hz.id} — {hz.name}
                      </Text>
                      <Text style={styles.zoneModalDesc}>{hz.desc}</Text>
                    </View>
                    <Text style={styles.zoneModalWatts}>{minBpm} - {maxBpm} bpm</Text>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* MODAL SELECTOR DE CICLOCOMPUTADOR */}
      <Modal visible={selector.visible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <Text style={[styles.modalTitle, { textAlign: 'center', marginBottom: 16 }]}>
              ¿Qué ciclocomputador utilizas?
            </Text>

            <TouchableOpacity
              style={styles.deviceOption}
              onPress={() => {
                setSelector({ ...selector, visible: false });
                sincronizarNube(selector.id);
              }}
            >
              <Text style={styles.deviceOptionTitle}>🔵 Garmin / Wahoo / Suunto</Text>
              <Text style={styles.deviceOptionSub}>Sincronización directa en la nube por WiFi / Bluetooth</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.deviceOption}
              onPress={() => {
                setSelector({ ...selector, visible: false });
                descargarArchivoFIT(selector.id, selector.nombre);
              }}
            >
              <Text style={styles.deviceOptionTitle}>⚪ Bryton / IGPSport / Otros</Text>
              <Text style={styles.deviceOptionSub}>Generar y compartir archivo binario universal (.FIT)</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.cancelModalBtn} onPress={() => setSelector({ ...selector, visible: false })}>
              <Text style={styles.cancelModalText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* MODAL DETALLE DE SESIÓN */}
      <Modal visible={sesionDetalle !== null} transparent animationType="slide" onRequestClose={() => setDetalleId(null)}>
        <View style={styles.modalBackdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setDetalleId(null)} />
          {sesionDetalle && renderDetalleSesion(sesionDetalle)}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617', paddingTop: 42 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#020617' },
  loadingText: { marginTop: 12, color: '#94a3b8', fontSize: 13, fontFamily: MONO_FONT },
  scrollContent: { padding: 14, paddingBottom: 120 },

  navbar: {
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandTitle: { fontSize: 16, fontWeight: '900', color: '#ffffff', letterSpacing: 0.4 },
  brandSubtitle: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  zonesBtn: {
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  zonesBtnText: { color: '#f8fafc', fontSize: 11, fontWeight: '800' },

  restOrTrainCard: {
    backgroundColor: '#0f172a',
    borderRadius: 18,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
  },
  rtTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  rtIndicatorDot: { width: 8, height: 8, borderRadius: 4 },
  rtOverline: { fontSize: 10, fontWeight: '900', color: '#94a3b8', fontFamily: MONO_FONT, flexShrink: 1 },
  rtVerdictBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, flexShrink: 0 },
  rtVerdictText: { fontSize: 10, fontWeight: '900', fontFamily: MONO_FONT },
  rtAdviceText: { fontSize: 11.5, color: '#cbd5e1', marginTop: 6, lineHeight: 16 },

  checkinBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 6,
    marginTop: 10,
  },
  checkinBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkinBtnText: { fontSize: 10, fontWeight: '800', fontFamily: MONO_FONT },

  dashboardPanel: {
    backgroundColor: '#0f172a',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 12,
    marginBottom: 14,
  },
  dashboardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    paddingBottom: 10,
    gap: 8,
  },
  panelTitle: { fontSize: 14, fontWeight: '800', color: '#ffffff' },
  panelSubtitle: { fontSize: 11, color: '#94a3b8', marginTop: 2, fontFamily: MONO_FONT },
  modelBadge: {
    backgroundColor: 'rgba(14,165,233,0.15)',
    borderColor: 'rgba(14,165,233,0.35)',
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 99,
  },
  modelBadgeText: { color: '#38bdf8', fontSize: 9.5, fontWeight: '800' },
  complianceBadge: {
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderColor: 'rgba(16,185,129,0.35)',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  complianceBadgeText: { color: '#34d399', fontSize: 10.5, fontWeight: '900', fontFamily: MONO_FONT },
  analiticaToggleText: { fontSize: 10, fontWeight: '800', color: '#34d399' },

  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8, marginTop: 10 },
  kpiCard: {
    width: '48.5%',
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  kpiLabel: { fontSize: 9.5, fontWeight: '800', color: '#94a3b8' },
  kpiMainVal: { fontSize: 17, fontWeight: '900', color: '#ffffff', fontFamily: MONO_FONT, marginTop: 3 },
  kpiSub: { fontSize: 10, color: '#94a3b8', marginTop: 2, fontFamily: MONO_FONT },

  progressTrack: { height: 6, backgroundColor: '#1e293b', borderRadius: 99, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#10b981', borderRadius: 99 },

  workoutCard: {
    backgroundColor: '#0f172a',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 12,
    overflow: 'hidden',
  },
  workoutCardCompleted: { borderColor: 'rgba(16,185,129,0.6)' },
  cardTopBar: {
    backgroundColor: 'rgba(2,6,23,0.6)',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  dayAvatar: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  dayAvatarActive: { backgroundColor: '#0f172a', borderColor: '#334155' },
  dayAvatarCompleted: { backgroundColor: '#10b981', borderColor: '#34d399' },
  dayAvatarRest: { backgroundColor: '#0f172a', borderColor: '#1e293b' },
  dayAvatarShort: { fontSize: 10, fontWeight: '900', color: '#34d399', fontFamily: MONO_FONT },
  dayAvatarNum: { fontSize: 10.5, fontWeight: '900', color: '#ffffff', fontFamily: MONO_FONT },
  dayNameText: { fontSize: 10.5, fontWeight: '800', color: '#34d399', textTransform: 'uppercase' },
  envBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  envIndoor: { backgroundColor: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.35)' },
  envOutdoor: { backgroundColor: 'rgba(14,165,233,0.15)', borderColor: 'rgba(14,165,233,0.35)' },
  envRest: { backgroundColor: '#1e293b', borderColor: '#334155' },
  envBadgeText: { fontSize: 9.5, fontWeight: '800' },
  workoutTitleText: { fontSize: 14.5, fontWeight: '800', color: '#ffffff', marginTop: 2 },

  doneBtn: {
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  doneBtnActive: { backgroundColor: '#10b981', borderColor: '#34d399' },
  doneBtnText: { fontSize: 11, fontWeight: '800', color: '#e2e8f0' },

  matchedActivityStrip: {
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderBottomWidth: 1,
    borderColor: 'rgba(16,185,129,0.3)',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  matchedActivityText: { fontSize: 10.5, fontWeight: '800', color: '#34d399', fontFamily: MONO_FONT },

  telemetryStrip: {
    backgroundColor: '#020617',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 7,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  stripMetricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stripItem: { fontSize: 11, fontFamily: MONO_FONT },
  stripLabel: { color: '#64748b', fontWeight: '700' },
  stripValWhite: { color: '#ffffff', fontWeight: '800' },
  choBadge: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderColor: 'rgba(245,158,11,0.3)',
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  choBadgeText: { color: '#fcd34d', fontSize: 10, fontWeight: '700', fontFamily: MONO_FONT },

  cardBody: { padding: 12 },
  powerChartBox: {
    height: 76,
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 8,
    justifyContent: 'flex-end',
    position: 'relative',
  },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', height: '100%', width: '100%' },
  ftpReferenceLine: {
    position: 'absolute',
    left: 6,
    right: 6,
    borderBottomWidth: 1,
    borderColor: 'rgba(251,191,36,0.6)',
    borderStyle: 'dashed',
    zIndex: 10,
    alignItems: 'flex-end',
  },
  ftpReferenceLabel: { color: '#fbbf24', fontSize: 8, fontWeight: '800', fontFamily: MONO_FONT, marginBottom: 1 },

  stepRow: {
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 4,
  },
  stepZoneTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, borderWidth: 1 },
  stepZoneTagText: { fontSize: 10, fontWeight: '900', fontFamily: MONO_FONT },
  stepRepsText: { fontSize: 12, fontWeight: '900', color: '#ffffff', fontFamily: MONO_FONT },
  stepLabelText: { fontSize: 12, fontWeight: '600', color: '#cbd5e1', flex: 1 },
  stepWattsInterval: { fontSize: 11, fontWeight: '700', color: '#fbbf24', fontFamily: MONO_FONT },
  stepWattsSteady: { fontSize: 11, fontWeight: '700', color: '#f8fafc', fontFamily: MONO_FONT },
  stepRecupText: { fontSize: 10, fontWeight: '600', color: '#94a3b8', fontFamily: MONO_FONT },
  sectionMiniTitle: { fontSize: 10, fontWeight: '800', color: '#94a3b8', letterSpacing: 0.4 },
  hydrationText: { fontSize: 11, color: '#38bdf8', fontWeight: '700', fontFamily: MONO_FONT },

  exportBtn: {
    marginTop: 12,
    backgroundColor: '#10b981',
    paddingVertical: 11,
    borderRadius: 12,
    alignItems: 'center',
  },
  exportBtnText: { color: '#020617', fontSize: 13, fontWeight: '900' },

  restBody: { padding: 14 },
  restSubText: { fontSize: 10.5, color: '#64748b', fontFamily: MONO_FONT },

  emptyBox: {
    backgroundColor: '#0f172a',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
  },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: '#ffffff', marginBottom: 6 },
  emptyText: { fontSize: 12, color: '#94a3b8', textAlign: 'center', lineHeight: 18 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: '#1e293b',
    padding: 18,
    paddingBottom: 34,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    paddingBottom: 12,
  },
  modalTitle: { fontSize: 16, fontWeight: '900', color: '#ffffff' },
  modalSubheader: { fontSize: 11, color: '#94a3b8', marginTop: 2, fontFamily: MONO_FONT },
  closeIconBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoneSectionHeader: { fontSize: 11, fontWeight: '900', color: '#fbbf24', marginBottom: 8 },
  zoneModalRow: {
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  zoneModalName: { fontSize: 12, fontWeight: '800', color: '#ffffff' },
  zoneModalDesc: { fontSize: 10, color: '#94a3b8', marginTop: 2 },
  zoneModalWatts: { fontSize: 12, fontWeight: '900', color: '#ffffff', fontFamily: MONO_FONT },

  deviceOption: {
    padding: 15,
    backgroundColor: '#020617',
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  deviceOptionTitle: { fontSize: 15, fontWeight: '800', color: '#ffffff' },
  deviceOptionSub: { fontSize: 12, color: '#94a3b8', marginTop: 3 },
  cancelModalBtn: { marginTop: 6, padding: 12, alignItems: 'center' },
  cancelModalText: { fontSize: 15, color: '#f43f5e', fontWeight: '800' },

  realActivityBanner: {
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderColor: '#10b981',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  realActivityTitle: { fontSize: 11, fontWeight: '900', color: '#34d399', marginBottom: 4 },
  realActivitySub: { fontSize: 11, color: '#e2e8f0', fontFamily: MONO_FONT, lineHeight: 16 },

  tapHintText: { fontSize: 11, color: '#34d399', fontWeight: '700' },
  origenEstructuraText: { fontSize: 10, fontWeight: '700' },
  coachNoteCard: {
    backgroundColor: 'rgba(16,185,129,0.07)',
    borderColor: 'rgba(16,185,129,0.3)',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
  },
  coachNoteCardTitle: { fontSize: 12, fontWeight: '900', color: '#34d399', marginBottom: 6 },
  coachNoteCardText: { fontSize: 14, color: '#e2e8f0', lineHeight: 21 },
});