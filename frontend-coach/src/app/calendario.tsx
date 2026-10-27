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
  Platform
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

const API_BASE = 'https://ai-cycling-coach-822a.onrender.com';
const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ============================================================================
// 1. DEFINICIÓN CIENTÍFICA DE ZONAS DE COGGAN (Z1-Z7) Y ZONAS FC (LTHR)
// ============================================================================
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

  // Acotamos el rango según el extremo de la zona (Bajo, Medio, Alto o Específico)
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

// ============================================================================
// 2. MOTOR TRADUCTOR DE SESIONES DE LA BD A BLOQUES FISIOLÓGICOS
// ============================================================================
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

// Convierte la estructura que diseña el coach (JSON guardado en la BD) a los bloques que dibuja la app.
function bloquesDesdeEstructura(raw: any): BloqueEntreno[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const num = (v: any, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const out: BloqueEntreno[] = [];
  raw.forEach((b: any) => {
    if (!b || typeof b !== 'object') return;
    const label = String(b.etiqueta || 'Bloque');
    if (b.tipo === 'intervalos') {
      out.push({
        type: 'interval',
        label,
        reps: Math.round(num(b.repeticiones, 1)),
        workMin: num(b.trabajo_min, 5),
        workPct: num(b.trabajo_ftp_pct, 95),
        workCadence: String(b.trabajo_cadencia || '90 rpm'),
        restMin: num(b.recuperacion_min, 3),
        restPct: num(b.recuperacion_ftp_pct, 55),
      });
    } else {
      out.push({
        type: 'steady',
        label,
        durationMin: num(b.duracion_min, 10),
        ftpPct: num(b.ftp_pct, 65),
        cadence: String(b.cadencia || '90 rpm'),
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

  // Si el coach diseñó la sesión bloque a bloque, dibujamos exactamente eso (sin adivinar por el nombre).
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

  if (texto.includes('vo2') || texto.includes('hiit') || texto.includes('rønnestad') || texto.includes('series')) {
    const reps = Math.max(3, Math.min(6, Math.floor(cuerpoMin / 8)));
    return {
      isRest: false,
      coachNote: 'Evita salir al 130% en el primer minuto. Busca un ritmo constante en zona Z5 con cadencia alta (95-100 rpm) para no saturar las piernas.',
      blocks: [
        { type: 'steady', label: 'Calentamiento Progresivo Z2', durationMin: calMin, ftpPct: 65, cadence: '90 rpm' },
        { type: 'interval', label: ' Potencia Aeróbica VO2Max', reps, workMin: 4, workPct: 112, workCadence: '95-100 rpm', restMin: 4, restPct: 52 },
        { type: 'steady', label: 'Enfriamiento Regenerativo Z1', durationMin: enfMin, ftpPct: 50, cadence: '85 rpm' },
      ] as BloqueEntreno[],
    };
  }

  if (texto.includes('umbral') || texto.includes('threshold') || texto.includes('ftp') || texto.includes('over')) {
    const reps = Math.max(2, Math.min(4, Math.floor(cuerpoMin / 14)));
    const workMin = Math.max(8, Math.round((cuerpoMin / reps) * 0.72));
    return {
      isRest: false,
      coachNote: 'Posición estable acoplado o en escaladores. Controla la respiración diafragmática y mantén una entrega de vatios constante en Z4.',
      blocks: [
        { type: 'steady', label: 'Calentamiento Aeróbico Z2', durationMin: calMin, ftpPct: 66, cadence: '90 rpm' },
        { type: 'interval', label: 'Cruceros en Umbral Funcional (FTP)', reps, workMin, workPct: 98, workCadence: '90-94 rpm', restMin: 4, restPct: 55 },
        { type: 'steady', label: 'Vuelta a la Calma Z1', durationMin: enfMin, ftpPct: 50, cadence: '85 rpm' },
      ] as BloqueEntreno[],
    };
  }

  if (texto.includes('sweet') || texto.includes('ss') || texto.includes('tempo') || texto.includes('fuerza') || texto.includes('torque')) {
    const reps = Math.max(2, Math.min(4, Math.floor(cuerpoMin / 14)));
    const workMin = Math.max(8, Math.round((cuerpoMin / reps) * 0.75));
    const cad = texto.includes('fuerza') || texto.includes('torque') ? '65-72 rpm' : '86-92 rpm';
    return {
      isRest: false,
      coachNote: 'Máxima relación estímulo fisiológico / fatiga. Mantén el core estable sin balancear los hombros y aplica par de fuerza redondo.',
      blocks: [
        { type: 'steady', label: 'Calentamiento Progresivo', durationMin: calMin, ftpPct: 62, cadence: '90 rpm' },
        { type: 'interval', label: 'Bloques Sweet Spot Sostenido', reps, workMin, workPct: 90, workCadence: cad, restMin: 4, restPct: 55 },
        { type: 'steady', label: 'Enfriamiento Suave Z1', durationMin: enfMin, ftpPct: 50, cadence: '85 rpm' },
      ] as BloqueEntreno[],
    };
  }

  if (texto.includes('recupera') || texto.includes('soltura') || texto.includes('z1') || texto.includes('regenera')) {
    return {
      isRest: false,
      coachNote: 'Pedaleo fluido sin tensión muscular. Mantén cadencia ágil (90-95 rpm) sin pasar del 55% de tu FTP para limpiar metabolitos.',
      blocks: [
        { type: 'steady', label: 'Soltura Z1 Progresiva', durationMin: 10, ftpPct: 45, cadence: '90 rpm' },
        { type: 'steady', label: 'Rodaje Regenerativo Z1', durationMin: Math.max(15, dur - 20), ftpPct: 52, cadence: '90-95 rpm' },
        { type: 'steady', label: 'Enfriamiento Suave', durationMin: 10, ftpPct: 45, cadence: '85 rpm' },
      ] as BloqueEntreno[],
    };
  }

  // ESTIMACIÓN (no es una regla para el coach): solo se usa si el coach NO guardó bloques y el nombre dice Endurance/Z2.
  // Dibuja Z2 puro para no inventar series que el nombre no menciona. Si el coach guarda 'bloques', este código
  // no interviene y no hay ningún límite de zonas ni de series.
  if (texto.includes('endurance') || texto.includes('zona 2') || /\bz2\b/.test(texto) || texto.includes('base aer')) {
    const bloquesZ2: BloqueEntreno[] = [
      { type: 'steady', label: 'Calentamiento Progresivo', durationMin: calMin, ftpPct: 58, cadence: '88 rpm' },
    ];
    // "Z3 final" en el nombre: los últimos minutos de la parte principal van en Z3
    const z3Final = /z3\s*final|final\s*z3|final en z3/.test(texto) ? Math.max(10, Math.min(30, Math.round(dur * 0.1))) : 0;
    const cuerpoZ2 = cuerpoMin - z3Final;
    let coachNoteZ2 =
      'Z2 estable y fluido: potencia constante entre el 60% y el 72% del FTP, sin picos y con el pulso estable.';
    if (texto.includes('cadencia')) {
      const reps = Math.max(3, Math.min(8, Math.floor(cuerpoZ2 / 15)));
      bloquesZ2.push({ type: 'interval', label: 'Z2 con cadencia alta', reps, workMin: 5, workPct: 66, workCadence: '100-105 rpm', restMin: 10, restPct: 66 });
      const sobrante = cuerpoZ2 - reps * 15;
      if (sobrante >= 5) {
        bloquesZ2.push({ type: 'steady', label: 'Z2 continuo', durationMin: sobrante, ftpPct: 68, cadence: '88-92 rpm' });
      }
      coachNoteZ2 =
        'Z2 estable con picos de cadencia: sube a 100-105 rpm sin que suban la potencia ni el pulso y vuelve a tu cadencia natural.';
    } else {
      bloquesZ2.push({ type: 'steady', label: 'Bloque Aeróbico Continuo Z2', durationMin: cuerpoZ2, ftpPct: 68, cadence: '88-92 rpm' });
    }
    if (z3Final > 0) {
      bloquesZ2.push({ type: 'steady', label: 'Final en Z3', durationMin: z3Final, ftpPct: 82, cadence: '85-90 rpm' });
    }
    bloquesZ2.push({ type: 'steady', label: 'Enfriamiento Suave', durationMin: enfMin, ftpPct: 52, cadence: '85 rpm' });
    return { isRest: false, coachNote: coachNoteZ2, blocks: bloquesZ2 };
  }

  if (dur >= 120 || texto.includes('everesting') || texto.includes('fondo') || texto.includes('puerto') || (entorno || '').toLowerCase().includes('outdoor')) {
    const bloquePuerto = Math.round(cuerpoMin * 0.45);
    const bloqueZ2 = Math.max(20, cuerpoMin - bloquePuerto);
    return {
      isRest: false,
      coachNote: 'Clave para Everesting y Gran Fondo: controla el pacing en subida sin superar el 82% del FTP y entrena el sistema digestivo (Gut Training) desde la primera hora.',
      blocks: [
        { type: 'steady', label: 'Aproximación Aeróbica Z2', durationMin: calMin, ftpPct: 64, cadence: '88 rpm' },
        { type: 'interval', label: 'Ascensos a Pacing Especifico Z2/Z3', reps: 3, workMin: Math.max(10, Math.round(bloquePuerto / 3)), workPct: 78, workCadence: '75-82 rpm', restMin: 5, restPct: 50 },
        { type: 'steady', label: 'Bloque Continuo FatMax Resistencia', durationMin: bloqueZ2, ftpPct: 68, cadence: '88 rpm' },
        { type: 'steady', label: 'Soltura Final a Casa', durationMin: enfMin, ftpPct: 52, cadence: '90 rpm' },
      ] as BloqueEntreno[],
    };
  }

  // Por defecto: Base Aeróbica Z2 / Mixto
  return {
    isRest: false,
    coachNote: 'Mantén una entrega de vatios constante entre el 65% y 72% del FTP sin picos en Z4. Vigila que el pulso no derive más de un 5%.',
    blocks: [
      { type: 'steady', label: 'Calentamiento Progresivo', durationMin: calMin, ftpPct: 58, cadence: '88 rpm' },
      { type: 'steady', label: 'Bloque Aeróbico Continuo FatMax Z2', durationMin: cuerpoMin, ftpPct: 70, cadence: '88-92 rpm' },
      { type: 'steady', label: 'Enfriamiento Suave', durationMin: enfMin, ftpPct: 52, cadence: '85 rpm' },
    ] as BloqueEntreno[],
  };
}

function calcularMetricasSesion(sesionItem: any, ftp: number) {
  const estBase = construirEstructuraSesion(sesionItem.sesion, sesionItem.duracion, sesionItem.entorno);
  const zoneMinutes: Record<string, number> = { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 0, Z6: 0, Z7: 0 };

  // 1. Mapear la estructura real de la IA (español/backend) al formato que dibuja la app (TypeScript)
  let bloquesActivos: BloqueEntreno[] = estBase.blocks;
  if (Array.isArray(sesionItem.estructura) && sesionItem.estructura.length > 0) {
    bloquesActivos = sesionItem.estructura.map((b: any) => {
      const tipo = (b.tipo || b.type || '').toLowerCase();
      if (tipo === 'intervalos' || tipo === 'interval' || b.repeticiones || b.reps) {
        return {
          type: 'interval',
          label: b.etiqueta || b.label || 'Series',
          reps: Number(b.repeticiones || b.reps) || 1,
          workMin: Number(b.trabajo_min || b.workMin) || 5,
          workPct: Number(b.trabajo_ftp_pct || b.workPct) || 95,
          workCadence: b.trabajo_cadencia || b.workCadence || '90 rpm',
          restMin: Number(b.recuperacion_min || b.restMin) || 3,
          restPct: Number(b.recuperacion_ftp_pct || b.restPct) || 55,
        } as BloqueEntreno;
      }
      return {
        type: 'steady',
        label: b.etiqueta || b.label || 'Bloque Continuo',
        durationMin: Number(b.duracion_min || b.durationMin) || 15,
        ftpPct: Number(b.ftp_pct || b.ftpPct) || 68,
        cadence: b.cadencia || b.cadence || '90 rpm',
      } as BloqueEntreno;
    });
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

  // 2. Desglosar los segmentos para calcular vatios, zonas y calorías
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

// Tiempo de una serie: admite fracciones de minuto (0.5 -> 30s, 1.5 -> 1m30s)
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

// ============================================================================
// 3. COMPONENTE PRINCIPAL: CALENDARIO Y TELEMETRÍA VELOCOACH PRO
// ============================================================================
export default function CalendarioScreen() {
  const [sesiones, setSesiones] = useState<any[]>([]);
  const [telemetria, setTelemetria] = useState({
    ftp: 305,
    peso: 71.0,
    lthr: 173,
    max_hr: 197,
    objetivo: 'Sin objetivo definido',
  });
  const [cargando, setCargando] = useState(true);

  // Modales: Exportación de Dispositivo y Laboratorio de Zonas Z1-Z7
  const [selector, setSelector] = useState({ visible: false, id: 0, nombre: '' });
  const [zonesModalVisible, setZonesModalVisible] = useState(false);
  const [macrociclo, setMacrociclo] = useState<any>({
    objetivo: 'Sin objetivo definido',
    fecha_meta: null,
    total_fases: 0,
    resumen_estrategico: null,
    fase_activa: null,
    fases: [],
  });
  const [planModalVisible, setPlanModalVisible] = useState(false);
  // Sesión cuyo detalle (desglose + nota del entrenador) está abierto en la hoja inferior
  const [detalleId, setDetalleId] = useState<number | null>(null);
  // Panel de analítica del microciclo: plegado por defecto para no saturar la pantalla
  const [analiticaAbierta, setAnaliticaAbierta] = useState(false);

  // Función auxiliar para formatear fechas como "9 oct – 1 nov"
  const formatearRangoFechas = (inicioStr: string, finStr: string) => {
    const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const d1 = new Date(`${inicioStr}T00:00:00`);
    const d2 = new Date(`${finStr}T00:00:00`);
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return `${inicioStr} – ${finStr}`;
    return `${d1.getDate()} ${meses[d1.getMonth()]} – ${d2.getDate()} ${meses[d2.getMonth()]}`;
  };

  const cargarCalendario = useCallback(async () => {
    try {
      const timestamp = new Date().getTime();
      const url = `${API_BASE}/api/calendario?t=${timestamp}`;
      const respuesta = await fetch(url, {
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache', Expires: '0' },
      });
      if (!respuesta.ok) {
        console.warn('Servidor actualizándose en Render, estado:', respuesta.status);
        return;
      }
      const data = await respuesta.json();

      if (Array.isArray(data)) {
        setSesiones(data);
      } else if (data && Array.isArray(data.sesiones)) {
        setSesiones(data.sesiones);
        if (data.telemetria) {
          setTelemetria((prev) => ({ ...prev, ...data.telemetria }));
        }
        if (data.macrociclo) {
          setMacrociclo(data.macrociclo);
        }
      }
    } catch (error) {
      console.error('Error cargando calendario:', error);
    } finally {
      setCargando(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      cargarCalendario();
    }, [cargarCalendario])
  );

  // Cambiar estado Completado / Pendiente
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

  // Adaptación rápida del entrenamiento de hoy (Check-in Join Cycling)
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
        Alert.alert('Sesión Adaptada ⚡', `Tu entrenamiento de hoy se ha recalculado a ${minutos} min (${sensacion}).`);
      } else {
        Alert.alert('Aviso', 'No se pudo adaptar la sesión en el servidor.');
      }
    } catch {
      Alert.alert('Error', 'Fallo de conexión al enviar el check-in.');
    } finally {
      setCargando(false);
    }
  };

  // Exportación 1: Nube (Garmin / Wahoo / Suunto)
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
    } catch (error) {
      Alert.alert('Error de Red', 'No se ha podido contactar con el servidor.');
    }
  };

  // Exportación 2: Archivo físico .FIT (Bryton / IGPSport / Otros)
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
    } catch (error) {
      Alert.alert('Error', 'Fallo al descargar el archivo.');
    }
  };

  // Cálculos agregados del Dashboard Semanal (Estilo VeloCoach Pro)
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
      const isCompleted = s.estado === 'Completado';

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
          totalCompletedTss += m.tss;
          totalCompletedMin += m.durationMin;
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

  const wkg = (telemetria.ftp / telemetria.peso).toFixed(2);
  const ssMin = Math.round(telemetria.ftp * 0.88);
  const ssMax = Math.round(telemetria.ftp * 0.94);

  // Sesión abierta en la hoja de detalle (se deriva del estado para que siga sincronizada al marcar "Hecho")
  const sesionDetalle =
    detalleId !== null
      ? resumenMicrociclo.sesionesEnriquecidas.find((s) => s.id === detalleId) ?? null
      : null;

  // Exportar desde la hoja: cerramos primero el detalle y abrimos el selector con un pequeño retardo
  // para que iOS no solape dos modales.
  const abrirSelectorExportacion = (item: any) => {
    setDetalleId(null);
    setTimeout(() => setSelector({ visible: true, id: item.id, nombre: item.sesion }), 350);
  };

  // Hoja de detalle: nota del entrenador + estructura por bloques + exportación
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
          <View style={styles.coachNoteCard}>
            <Text style={styles.coachNoteCardTitle}>🎙️ Nota del entrenador</Text>
            <Text style={styles.coachNoteCardText}>{m.coachNote}</Text>
          </View>

          {!m.isRest && (
            <>
              <Text style={[styles.sectionMiniTitle, { marginTop: 18, marginBottom: 8 }]}>
                ESTRUCTURA DE LA SESIÓN
              </Text>
              {!bloquesDesdeEstructura(item.estructura) && (
                <Text style={[styles.origenEstructuraText, { color: '#fbbf24', marginTop: 0, marginBottom: 8 }]}>
                  ≈ Estimada a partir del nombre de la sesión. Pide al coach que reestructure la semana para fijar los bloques reales.
                </Text>
              )}

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
        <Text style={styles.loadingText}>Sincronizando telemetría y microciclo...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* ==================== TOP TELEMETRY NAVBAR ==================== */}
      <View style={styles.navbar}>
        <View style={styles.brandRow}>
          <View style={styles.brandIcon}>
            <Text style={{ fontSize: 18 }}>🚴‍♂️</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Text style={styles.brandTitle}>
                VELO<Text style={{ color: '#34d399' }}>COACH</Text>
              </Text>
              <View style={styles.proWattBadge}>
                <Text style={styles.proWattBadgeText}>PRO WATT LAB</Text>
              </View>
            </View>
            <Text style={styles.brandSubtitle} numberOfLines={1}>
              🎯 {telemetria.objetivo} • Fisiología y Zonas Coggan
            </Text>
          </View>
        </View>

        {/* Píldoras de Telemetría + Botón Zonas Z1-Z7 libre del engranaje superior */}
        <View style={styles.telemetryPillsBar}>
          <View style={styles.pillItem}>
            <Text style={styles.pillLabel}>FTP:</Text>
            <Text style={[styles.pillValue, { color: '#fbbf24' }]}>{telemetria.ftp}W</Text>
          </View>
          <View style={styles.pillDivider} />
          <View style={styles.pillItem}>
            <Text style={styles.pillLabel}>Ratio:</Text>
            <Text style={[styles.pillValue, { color: '#34d399' }]}>{wkg} W/kg</Text>
          </View>
          <View style={styles.pillDivider} />
          <TouchableOpacity style={styles.zonesBtn} onPress={() => setZonesModalVisible(true)}>
            <Text style={styles.zonesBtnText}>⚡ Zonas Z1-Z7</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* ==================== BANNER DE FASE ACTIVA DEL MACROCICLO ==================== */}
        {/* ==================== BANNER DE FASE ACTIVA DEL MACROCICLO (SIN TEXTO CORTADO) ==================== */}
        <TouchableOpacity
          style={styles.macroBanner}
          activeOpacity={0.85}
          onPress={() => setPlanModalVisible(true)}
        >
          {/* Fila superior: Estado del bloque a la izquierda + Botón Ver Plan a la derecha */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              <View style={styles.phaseRingActive}>
                <View style={styles.phaseRingInnerDot} />
              </View>
              <Text style={[styles.macroBannerOverline, { flex: 1 }]}>
                {macrociclo.fase_activa
                  ? `BLOQUE ACTIVO • ${formatearRangoFechas(macrociclo.fase_activa.fecha_inicio, macrociclo.fase_activa.fecha_fin).toUpperCase()}`
                  : 'PLANIFICACIÓN POR BLOQUES'}
              </Text>
            </View>

            <View style={styles.verPlanPill}>
              <Text style={styles.verPlanPillText}>
                🗺️ Ver Plan ({macrociclo.total_fases || 0})
              </Text>
            </View>
          </View>

          {/* Cuerpo inferior: 100% de ancho sin recortes */}
          <View style={{ marginTop: 10 }}>
            <Text style={styles.macroBannerTitle}>
              {macrociclo.fase_activa
                ? macrociclo.fase_activa.nombre
                : `${macrociclo.objetivo}${macrociclo.fecha_meta ? ` (${macrociclo.fecha_meta})` : ''}`}
            </Text>

            {macrociclo.fase_activa ? (
              <>
                <Text style={[styles.macroBannerDesc, { marginTop: 4 }]}>
                  {macrociclo.fase_activa.descripcion}
                </Text>
                <Text style={styles.quedanDiasText}>
                  Quedan {macrociclo.fase_activa.dias_restantes} días en este bloque
                </Text>
              </>
            ) : (
              <Text style={[styles.macroBannerDesc, { marginTop: 4 }]}>
                Pídele al Coach IA en el chat que estructure los bloques de entrenamiento para tu objetivo.
              </Text>
            )}
          </View>
        </TouchableOpacity>

        {/* ==================== ACCIONES RÁPIDAS: CHECK-IN DIARIO (ESTILO JOIN) ==================== */}
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

        {/* ==================== 1. DASHBOARD DE CARGA FISIOLÓGICA ==================== */}
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
                <Text style={styles.panelTitle}>Analítica del Microciclo</Text>
                <View style={styles.modelBadge}>
                  <Text style={styles.modelBadgeText}>{resumenMicrociclo.modeloDist}</Text>
                </View>
              </View>
              <Text style={styles.panelSubtitle}>
                {analiticaAbierta
                  ? `Vatios exactos calculados sobre tu FTP actual (${telemetria.ftp}W • SS: ${ssMin}-${ssMax}W)`
                  : `TSS ${resumenMicrociclo.totalCompletedTss}/${resumenMicrociclo.totalPlannedTss} • ${formatDurationHm(resumenMicrociclo.totalPlannedMin)} • IF ${resumenMicrociclo.avgIf}`}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              <View style={styles.complianceBadge}>
                <Text style={styles.complianceBadgeText}>
                  {resumenMicrociclo.compliancePct}% ({resumenMicrociclo.completedSessionsCount}/{resumenMicrociclo.activeSessionsCount})
                </Text>
              </View>
              <Text style={styles.analiticaToggleText}>{analiticaAbierta ? 'Ocultar ▴' : 'Ver detalle ▾'}</Text>
            </View>
          </TouchableOpacity>

          {/* Barra de progreso visible solo con el panel plegado (desplegado ya tiene la suya) */}
          {!analiticaAbierta && (
            <View style={[styles.progressTrack, { marginTop: 10 }]}>
              <View style={[styles.progressFill, { width: `${resumenMicrociclo.compliancePct}%` }]} />
            </View>
          )}

          {/* Detalle: solo visible al desplegar */}
          {analiticaAbierta && (
          <>
          {/* 5 Tarjetas KPI de Telemetría */}
          <View style={styles.kpiGrid}>
            <View style={styles.kpiCard}>
              <Text style={styles.kpiLabel}>🔥 TSS SEMANAL</Text>
              <View style={styles.kpiValRow}>
                <Text style={styles.kpiMainVal}>{resumenMicrociclo.totalPlannedTss}</Text>
                <Text style={styles.kpiUnit}>TSS</Text>
              </View>
              <Text style={[styles.kpiSub, { color: '#34d399' }]}>
                Hecho: {resumenMicrociclo.totalCompletedTss} TSS
              </Text>
            </View>

            <View style={styles.kpiCard}>
              <Text style={styles.kpiLabel}>⏱️ VOLUMEN TOTAL</Text>
              <View style={styles.kpiValRow}>
                <Text style={styles.kpiMainVal}>
                  {formatDurationHm(resumenMicrociclo.totalPlannedMin)}
                </Text>
              </View>
              <Text style={[styles.kpiSub, { color: '#38bdf8' }]}>
                Hecho: {formatDurationHm(resumenMicrociclo.totalCompletedMin)}
              </Text>
            </View>

            <View style={styles.kpiCard}>
              <Text style={styles.kpiLabel}>⚡ IF MEDIO / NP</Text>
              <View style={styles.kpiValRow}>
                <Text style={[styles.kpiMainVal, { color: '#34d399' }]}>
                  {resumenMicrociclo.avgIf}
                </Text>
                <Text style={styles.kpiUnit}>IF</Text>
              </View>
              <Text style={styles.kpiSub}>NP Media: {resumenMicrociclo.avgNp}W</Text>
            </View>

            <View style={styles.kpiCard}>
              <Text style={styles.kpiLabel}>🔋 TRABAJO MEC.</Text>
              <View style={styles.kpiValRow}>
                <Text style={styles.kpiMainVal}>{resumenMicrociclo.totalKj}</Text>
                <Text style={styles.kpiUnit}>kJ</Text>
              </View>
              <Text style={styles.kpiSub}>≈ {resumenMicrociclo.totalKj} kcal</Text>
            </View>

            {/* Tarjeta CHO Corregida: Nunca se sale por la derecha */}
            <View style={[styles.kpiCard, styles.kpiCardFullWidth]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.kpiLabel, { color: '#fbbf24' }]}>🍼 NUTRICIÓN EN RUTA (CHO)</Text>
                  <Text style={styles.kpiSub} numberOfLines={1}>
                    Total estimado: {resumenMicrociclo.totalChoGrams}g Carbohidratos
                  </Text>
                </View>
                <Text style={[styles.kpiMainVal, { color: '#fbbf24', fontSize: 16, flexShrink: 0 }]}>
                  60-90 g/h
                </Text>
              </View>
            </View>
          </View>

          {/* Distribución de Tiempo en Zonas Z1-Z7 Corregida */}
          <View style={styles.zonesDistributionSection}>
            <View style={{ marginBottom: 8 }}>
              <Text style={styles.sectionMiniTitle}>DISTRIBUCIÓN EN ZONAS DE POTENCIA</Text>
              <Text style={styles.zoneSplitText}>
                Z1-Z2: {resumenMicrociclo.lowPct}% • Z3-Z4: {resumenMicrociclo.midPct}% • Z5+: {resumenMicrociclo.highPct}%
              </Text>
            </View>

            {/* Barra horizontal apilada */}
            <View style={styles.stackedBarContainer}>
              {COGGAN_ZONES.map((z) => {
                const mins = resumenMicrociclo.weeklyZonesMin[z.id] || 0;
                if (mins <= 0) return null;
                return (
                  <View
                    key={z.id}
                    style={{
                      flex: mins,
                      backgroundColor: z.color,
                      height: '100%',
                    }}
                  />
                );
              })}
            </View>

            {/* 7 Píldoras Z1-Z7 alineadas en una única fila */}
            <View style={styles.zonesLegendGrid}>
              {COGGAN_ZONES.map((z) => {
                const mins = Math.round(resumenMicrociclo.weeklyZonesMin[z.id] || 0);
                const pct =
                  resumenMicrociclo.totalPlannedMin > 0
                    ? Math.round((mins / resumenMicrociclo.totalPlannedMin) * 100)
                    : 0;
                return (
                  <View key={z.id} style={styles.zoneLegendPill}>
                    <Text style={[styles.zonePillId, { color: z.color }]}>{z.id}</Text>
                    <Text style={styles.zonePillPct}>{pct}%</Text>
                    <Text style={styles.zonePillMins}>{mins}m</Text>
                  </View>
                );
              })}
            </View>

            {/* Barra de cumplimiento de TSS */}
            <View style={styles.complianceBox}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={styles.complianceTitle}>Progreso TSS Completado</Text>
                <Text style={styles.compliancePctText}>{resumenMicrociclo.compliancePct}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${resumenMicrociclo.compliancePct}%` },
                  ]}
                />
              </View>
            </View>
          </View>
          </>
          )}
        </View>

        {/* ==================== 2. TARJETAS DE ENTRENAMIENTO SEMANAL ==================== */}
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionMainTitle}>🗓️ Planificador de Sesiones y Bloques</Text>
          <Text style={styles.sectionMainSubtitle}>
            Toca una sesión para ver el desglose por bloques y la nota del entrenador.
          </Text>
        </View>

        {resumenMicrociclo.sesionesEnriquecidas.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>Sin sesiones activas en la agenda</Text>
            <Text style={styles.emptyText}>
              Abre la pestaña del Coach IA y pídele que planifique tu semana para el {telemetria.objetivo}.
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
                        {item.isCompleted ? '✓ Hecho' : 'Marcar Hecho'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>

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
                          <Text style={{ color: '#fbbf24', fontWeight: '800' }}>{m.tss}</Text>
                        </Text>
                        <Text style={styles.stripItem}>
                          <Text style={styles.stripLabel}>IF: </Text>
                          <Text style={{ color: '#34d399', fontWeight: '800' }}>{m.ifVal}</Text>
                        </Text>
                        <Text style={styles.stripItem}>
                          <Text style={styles.stripLabel}>NP: </Text>
                          <Text style={{ color: '#38bdf8', fontWeight: '800' }}>{m.np}W</Text>
                        </Text>
                        <Text style={styles.stripItem}>
                          <Text style={styles.stripLabel}>Trabajo: </Text>
                          <Text style={{ color: '#c084fc', fontWeight: '800' }}>{m.kj} kJ</Text>
                        </Text>
                      </View>
                      <View style={styles.choBadge}>
                        <Text style={styles.choBadgeText}>⚡ Nutrición: {m.choPerHour}</Text>
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

                      <Text
                        style={[
                          styles.origenEstructuraText,
                          { color: bloquesDesdeEstructura(item.estructura) ? '#34d399' : '#fbbf24' },
                        ]}
                      >
                        {bloquesDesdeEstructura(item.estructura)
                          ? '✔ Bloques diseñados por el coach'
                          : '≈ Estimada por la app: el coach no guardó los bloques'}
                      </Text>

                      <View style={styles.tapHintRow}>
                        <Text style={styles.tapHintText}>Ver desglose y nota del entrenador</Text>
                        <Text style={styles.tapHintText}>›</Text>
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

      {/* ==================== MODAL 1: LABORATORIO DE ZONAS Z1-Z7 & FC ==================== */}
      <Modal visible={zonesModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { maxHeight: '88%' }]}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>⚡ Laboratorio Fisiológico: Coggan Z1-Z7 y FC</Text>
                <Text style={styles.modalSubheader}>
                  FTP: {telemetria.ftp}W ({wkg} W/kg) • LTHR: {telemetria.lthr} bpm • FC Máx: {telemetria.max_hr} bpm
                </Text>
              </View>
              <TouchableOpacity
                style={styles.closeIconBtn}
                onPress={() => setZonesModalVisible(false)}
              >
                <Text style={{ color: '#cbd5e1', fontWeight: 'bold' }}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={{ marginTop: 12 }} showsVerticalScrollIndicator={false}>
              <Text style={styles.zoneSectionHeader}>🔥 7 ZONAS DE POTENCIA (DR. ANDREW COGGAN)</Text>
              {COGGAN_ZONES.map((z) => {
                const minW = Math.round(telemetria.ftp * (z.minPct / 100));
                const maxW = Math.round(telemetria.ftp * (z.maxPct / 100));
                const rangeStr =
                  z.id === 'Z1'
                    ? `< ${maxW}W`
                    : z.id === 'Z7'
                      ? `> ${minW}W`
                      : `${minW} - ${maxW}W`;
                return (
                  <View key={z.id} style={styles.zoneModalRow}>
                    <View style={[styles.stepZoneTag, { backgroundColor: z.bgBadge, borderColor: z.color }]}>
                      <Text style={[styles.stepZoneTagText, { color: z.color }]}>{z.id}</Text>
                    </View>
                    <View style={{ flex: 1, marginHorizontal: 10 }}>
                      <Text style={styles.zoneModalName}>
                        {z.name} ({z.minPct}-{z.id === 'Z7' ? 'MAX' : `${z.maxPct}%`})
                      </Text>
                      <Text style={styles.zoneModalDesc}>{z.desc}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={styles.zoneModalWatts}>{rangeStr}</Text>
                      <Text style={styles.zoneModalWkg}>{(minW / telemetria.peso).toFixed(1)} W/kg</Text>
                    </View>
                  </View>
                );
              })}

              <Text style={[styles.zoneSectionHeader, { color: '#fb7185', marginTop: 18 }]}>
                ❤️ 5 ZONAS DE FRECUENCIA CARDÍACA (LTHR)
              </Text>
              {HR_ZONES.map((hz) => {
                const minBpm =
                  hz.minLthrPct === 0
                    ? Math.round(telemetria.lthr * 0.55)
                    : Math.round(telemetria.lthr * (hz.minLthrPct / 100));
                const maxBpm =
                  hz.id === 'FC Z5'
                    ? telemetria.max_hr
                    : Math.round(telemetria.lthr * (hz.maxLthrPct / 100));
                return (
                  <View key={hz.id} style={styles.zoneModalRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.zoneModalName, { color: hz.color }]}>
                        {hz.id} — {hz.name}
                      </Text>
                      <Text style={styles.zoneModalDesc}>{hz.desc}</Text>
                    </View>
                    <Text style={styles.zoneModalWatts}>
                      {minBpm} - {maxBpm} bpm
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ==================== MODAL 2: SELECTOR DE CICLOCOMPUTADOR ==================== */}
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
              <Text style={styles.deviceOptionSub}>
                Sincronización directa en la nube por WiFi / Bluetooth
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.deviceOption}
              onPress={() => {
                setSelector({ ...selector, visible: false });
                descargarArchivoFIT(selector.id, selector.nombre);
              }}
            >
              <Text style={styles.deviceOptionTitle}>⚪ Bryton / IGPSport / Otros</Text>
              <Text style={styles.deviceOptionSub}>
                Generar y compartir archivo binario universal (.FIT)
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cancelModalBtn}
              onPress={() => setSelector({ ...selector, visible: false })}
            >
              <Text style={styles.cancelModalText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      {/* ==================== MODAL 3: PLAN MACROCICLO (LÍNEA TEMPORAL DE FASES) ==================== */}
      <Modal visible={planModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { height: '90%' }]}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>
                  {macrociclo.objetivo} — {macrociclo.fecha_meta}
                </Text>
                <Text style={styles.modalSubheader}>
                  {macrociclo.total_fases} fases estructuradas a medida
                </Text>
              </View>
              <TouchableOpacity
                style={styles.closeIconBtn}
                onPress={() => setPlanModalVisible(false)}
              >
                <Text style={{ color: '#cbd5e1', fontWeight: 'bold' }}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={{ marginTop: 14 }} showsVerticalScrollIndicator={false}>
              {/* Diagnóstico Estratégico e Histórico (Como en la Captura 1) */}
              {macrociclo.resumen_estrategico ? (
                <View style={styles.estrategiaBox}>
                  <Text style={styles.estrategiaText}>{macrociclo.resumen_estrategico}</Text>
                </View>
              ) : (
                <View style={styles.estrategiaBox}>
                  <Text style={styles.estrategiaText}>
                    Aún no has generado los bloques de tu temporada. Ve a la pestaña Coach IA y dile:
                    "Estructúrame el plan por bloques para mi objetivo". El entrenador analizará tus horas y desnivel del último año y diseñará tus fases.
                  </Text>
                </View>
              )}

              {/* Línea Temporal Vertical de Bloques (Como en las Capturas 2, 3 y 4) */}
              <View style={{ marginTop: 18, paddingLeft: 4 }}>
                {macrociclo.fases.map((fase: any, index: number) => {
                  const esUltima = index === macrociclo.fases.length - 1;
                  const esActiva = fase.estado === 'activa';
                  const esCompletada = fase.estado === 'completada';

                  return (
                    <View key={fase.id || index} style={styles.timelineItemRow}>
                      {/* Columna izquierda: Círculo de estado + Línea conectora vertical */}
                      <View style={styles.timelineLeftCol}>
                        <View
                          style={[
                            styles.timelineCircle,
                            esActiva && styles.timelineCircleActive,
                            esCompletada && styles.timelineCircleDone,
                          ]}
                        >
                          {esActiva && <View style={styles.timelineInnerDotActive} />}
                          {esCompletada && (
                            <Text style={{ fontSize: 10, color: '#020617', fontWeight: '900' }}>✓</Text>
                          )}
                        </View>
                        {!esUltima && (
                          <View
                            style={[
                              styles.timelineLine,
                              esCompletada && { backgroundColor: '#10b981' },
                            ]}
                          />
                        )}
                      </View>

                      {/* Columna derecha: Fechas, Título del Bloque, Explicación y Días restantes */}
                      <View style={[styles.timelineRightCol, esActiva && styles.timelineCardActive]}>
                        <Text style={styles.timelineDates}>
                          {formatearRangoFechas(fase.fecha_inicio, fase.fecha_fin)}
                        </Text>
                        <Text style={styles.timelinePhaseTitle}>{fase.nombre}</Text>
                        <Text style={styles.timelinePhaseDesc}>{fase.descripcion}</Text>

                        {fase.foco ? (
                          <Text style={styles.timelinePhaseFocus}>🎯 Foco: {fase.foco}</Text>
                        ) : null}

                        {esActiva && (
                          <Text style={styles.quedanDiasText}>
                            Quedan {fase.dias_restantes} días
                          </Text>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ==================== MODAL 4: DETALLE DE SESIÓN (NOTA DEL ENTRENADOR + DESGLOSE) ==================== */}
      <Modal
        visible={sesionDetalle !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setDetalleId(null)}
      >
        <View style={styles.modalBackdrop}>
          {/* Tocar fuera de la hoja la cierra */}
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
  scrollContent: { padding: 14, paddingBottom: 130 },

  // Navbar con espacio reservado a la derecha para el botón de engranaje
  navbar: {
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 48 },
  brandIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandTitle: { fontSize: 17, fontWeight: '900', color: '#ffffff', letterSpacing: 0.5 },
  proWattBadge: {
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderColor: 'rgba(245,158,11,0.35)',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  proWattBadgeText: { color: '#fbbf24', fontSize: 9, fontWeight: '800', fontFamily: MONO_FONT },
  brandSubtitle: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  zonesBtn: {
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
  },
  zonesBtnText: { color: '#f8fafc', fontSize: 10, fontWeight: '800' },

  telemetryPillsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 10,
  },
  pillItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pillLabel: { fontSize: 11, color: '#64748b', fontWeight: '700' },
  pillValue: { fontSize: 12, fontWeight: '800', fontFamily: MONO_FONT },
  pillDivider: { width: 1, height: 12, backgroundColor: '#1e293b' },

  // Dashboard Panel
  dashboardPanel: {
    backgroundColor: '#0f172a',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 14,
    marginBottom: 18,
  },
  dashboardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    paddingBottom: 12,
    gap: 8,
  },
  panelTitle: { fontSize: 15, fontWeight: '800', color: '#ffffff' },
  panelSubtitle: { fontSize: 11, color: '#94a3b8', marginTop: 3 },
  modelBadge: {
    backgroundColor: 'rgba(14,165,233,0.15)',
    borderColor: 'rgba(14,165,233,0.35)',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 99,
  },
  modelBadgeText: { color: '#38bdf8', fontSize: 10, fontWeight: '800' },
  complianceBadge: {
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderColor: 'rgba(16,185,129,0.35)',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  complianceBadgeText: { color: '#34d399', fontSize: 11, fontWeight: '900', fontFamily: MONO_FONT },

  // KPI Cards
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8, marginTop: 12 },
  kpiCard: {
    width: '48.5%',
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 14,
    padding: 11,
  },
  kpiCardFullWidth: {
    width: '100%',
    borderColor: 'rgba(245,158,11,0.25)',
  },
  kpiLabel: { fontSize: 10, fontWeight: '800', color: '#94a3b8' },
  kpiValRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 4 },
  kpiMainVal: { fontSize: 20, fontWeight: '900', color: '#ffffff', fontFamily: MONO_FONT },
  kpiUnit: { fontSize: 11, color: '#64748b', fontFamily: MONO_FONT, fontWeight: '700' },
  kpiSub: { fontSize: 10, color: '#94a3b8', marginTop: 3, fontFamily: MONO_FONT },

  // Zones Distribution Corregida
  zonesDistributionSection: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: '#1e293b',
  },
  sectionMiniTitle: { fontSize: 10, fontWeight: '800', color: '#94a3b8', letterSpacing: 0.4 },
  zoneSplitText: { fontSize: 11, color: '#cbd5e1', fontFamily: MONO_FONT, marginTop: 3 },
  stackedBarContainer: {
    height: 12,
    backgroundColor: '#020617',
    borderRadius: 99,
    overflow: 'hidden',
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 1,
    gap: 1,
  },
  zonesLegendGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 4,
    marginTop: 8,
  },
  zoneLegendPill: {
    flex: 1,
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 3,
    alignItems: 'center',
  },
  zonePillId: { fontSize: 10, fontWeight: '900', fontFamily: MONO_FONT },
  zonePillPct: { fontSize: 8, color: '#64748b', fontFamily: MONO_FONT, marginTop: 1 },
  zonePillMins: { fontSize: 9, fontWeight: '800', color: '#ffffff', fontFamily: MONO_FONT, marginTop: 2 },

  complianceBox: {
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginTop: 10,
  },
  complianceTitle: { fontSize: 11, fontWeight: '700', color: '#cbd5e1' },
  compliancePctText: { fontSize: 11, fontWeight: '900', color: '#34d399', fontFamily: MONO_FONT },
  progressTrack: {
    height: 8,
    backgroundColor: '#1e293b',
    borderRadius: 99,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#10b981', borderRadius: 99 },

  sectionHeaderRow: { marginBottom: 12, paddingHorizontal: 2 },
  sectionMainTitle: { fontSize: 17, fontWeight: '900', color: '#ffffff' },
  sectionMainSubtitle: { fontSize: 11, color: '#94a3b8', marginTop: 2 },

  workoutCard: {
    backgroundColor: '#0f172a',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 14,
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
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  dayAvatarActive: { backgroundColor: '#0f172a', borderColor: '#334155' },
  dayAvatarCompleted: { backgroundColor: '#10b981', borderColor: '#34d399' },
  dayAvatarRest: { backgroundColor: '#0f172a', borderColor: '#1e293b' },
  dayAvatarShort: { fontSize: 10, fontWeight: '900', color: '#34d399', fontFamily: MONO_FONT },
  dayAvatarNum: { fontSize: 11, fontWeight: '900', color: '#ffffff', fontFamily: MONO_FONT },
  dayNameText: { fontSize: 11, fontWeight: '800', color: '#34d399', textTransform: 'uppercase' },
  envBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  envIndoor: { backgroundColor: 'rgba(245,158,11,0.15)', borderColor: 'rgba(245,158,11,0.35)' },
  envOutdoor: { backgroundColor: 'rgba(14,165,233,0.15)', borderColor: 'rgba(14,165,233,0.35)' },
  envRest: { backgroundColor: '#1e293b', borderColor: '#334155' },
  envBadgeText: { fontSize: 10, fontWeight: '800' },
  workoutTitleText: { fontSize: 15, fontWeight: '800', color: '#ffffff', marginTop: 3 },

  doneBtn: {
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
  },
  doneBtnActive: { backgroundColor: '#10b981', borderColor: '#34d399' },
  doneBtnText: { fontSize: 11, fontWeight: '800', color: '#e2e8f0' },

  telemetryStrip: {
    backgroundColor: '#020617',
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 8,
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
    height: 82,
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 8,
    justifyContent: 'flex-end',
    position: 'relative',
  },
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: '100%',
    width: '100%',
  },
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
  ftpReferenceLabel: {
    color: '#fbbf24',
    fontSize: 8,
    fontWeight: '800',
    fontFamily: MONO_FONT,
    marginBottom: 1,
  },

  stepRow: {
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 4,
  },
  stepZoneTag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
  },
  stepZoneTagText: { fontSize: 10, fontWeight: '900', fontFamily: MONO_FONT },
  stepRepsText: { fontSize: 12, fontWeight: '900', color: '#ffffff', fontFamily: MONO_FONT },
  stepLabelText: { fontSize: 12, fontWeight: '600', color: '#cbd5e1', flex: 1 },
  stepWattsInterval: { fontSize: 11, fontWeight: '700', color: '#fbbf24', fontFamily: MONO_FONT },
  stepWattsSteady: { fontSize: 11, fontWeight: '700', color: '#f8fafc', fontFamily: MONO_FONT },
  stepRecupText: { fontSize: 10, fontWeight: '600', color: '#94a3b8', fontFamily: MONO_FONT },

  coachFooterBox: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderColor: '#1e293b',
    gap: 6,
  },
  coachNoteText: { fontSize: 11, color: '#94a3b8', lineHeight: 16 },
  hydrationText: { fontSize: 11, color: '#38bdf8', fontWeight: '700', fontFamily: MONO_FONT },

  exportBtn: {
    marginTop: 12,
    backgroundColor: '#10b981',
    paddingVertical: 11,
    borderRadius: 12,
    alignItems: 'center',
  },
  exportBtnText: { color: '#020617', fontSize: 13, fontWeight: '900' },

  restBody: { padding: 14, gap: 4 },
  restSubText: { fontSize: 10, color: '#64748b', fontFamily: MONO_FONT },

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

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
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
  zoneSectionHeader: {
    fontSize: 11,
    fontWeight: '900',
    color: '#fbbf24',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
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
  zoneModalWkg: { fontSize: 10, color: '#64748b', fontFamily: MONO_FONT },

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

  // Estilos del Banner y Línea Temporal del Macrociclo
  macroBanner: {
    backgroundColor: '#0f172a',
    borderColor: 'rgba(16,185,129,0.45)',
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    marginBottom: 14,
  },
  phaseRingActive: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 3,
    borderColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  phaseRingInnerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10b981',
  },
  macroBannerOverline: {
    fontSize: 10,
    fontWeight: '800',
    color: '#34d399',
    fontFamily: MONO_FONT,
  },
  macroBannerTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#ffffff',
    marginTop: 1,
  },
  macroBannerDesc: {
    fontSize: 12,
    color: '#cbd5e1',
    lineHeight: 17,
  },
  verPlanPill: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderColor: 'rgba(16,185,129,0.35)',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  verPlanPillText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '800',
  },
  quedanDiasText: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 6,
  },
  estrategiaBox: {
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
  },
  estrategiaText: {
    fontSize: 13,
    color: '#e2e8f0',
    lineHeight: 20,
  },
  timelineItemRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  timelineLeftCol: {
    width: 32,
    alignItems: 'center',
  },
  timelineCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#475569',
    backgroundColor: '#020617',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  timelineCircleActive: {
    borderColor: '#10b981',
    borderWidth: 3,
  },
  timelineCircleDone: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  timelineInnerDotActive: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10b981',
  },
  timelineLine: {
    width: 2,
    flex: 1,
    backgroundColor: '#1e293b',
    marginVertical: 2,
  },
  timelineRightCol: {
    flex: 1,
    paddingBottom: 22,
    paddingLeft: 10,
  },
  timelineCardActive: {
    backgroundColor: 'rgba(16,185,129,0.06)',
    borderColor: 'rgba(16,185,129,0.25)',
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 14,
  },
  timelineDates: {
    fontSize: 12,
    color: '#94a3b8',
    fontFamily: MONO_FONT,
    fontWeight: '700',
  },
  timelinePhaseTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: '#ffffff',
    marginTop: 2,
    marginBottom: 6,
  },
  timelinePhaseDesc: {
    fontSize: 13,
    color: '#cbd5e1',
    lineHeight: 19,
  },
  timelinePhaseFocus: {
    fontSize: 11,
    color: '#fbbf24',
    fontFamily: MONO_FONT,
    marginTop: 6,
    fontWeight: '700',
  },

  // Tarjeta compacta: pista de toque + hoja de detalle de la sesión
  tapHintRow: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  tapHintText: { fontSize: 11, color: '#34d399', fontWeight: '700' },
  origenEstructuraText: { fontSize: 10, fontWeight: '700', marginTop: 8 },
  coachNoteCard: {
    backgroundColor: 'rgba(16,185,129,0.07)',
    borderColor: 'rgba(16,185,129,0.3)',
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
  },
  coachNoteCardTitle: { fontSize: 12, fontWeight: '900', color: '#34d399', marginBottom: 6 },
  coachNoteCardText: { fontSize: 14, color: '#e2e8f0', lineHeight: 21 },

  analiticaToggleText: { fontSize: 10, fontWeight: '800', color: '#34d399' },

  checkinBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 14,
  },
  checkinBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkinBtnText: {
    fontSize: 10,
    fontWeight: '800',
    fontFamily: MONO_FONT,
  },
});