import React, { useState, useCallback } from 'react';
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
  TextInput,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from 'expo-router';

const API_BASE = 'https://ai-cycling-coach-822a.onrender.com';
const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DIAS_ORDEN_CONFIG = [
  { key: 'L', label: 'Lunes' },
  { key: 'M', label: 'Martes' },
  { key: 'X', label: 'Miércoles' },
  { key: 'J', label: 'Jueves' },
  { key: 'V', label: 'Viernes' },
  { key: 'S', label: 'Sábado' },
  { key: 'D', label: 'Domingo' },
];

function formatDurationHm(totalMinutes: number) {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m < 10 ? '0' + m : m}m`;
}

export default function TemporadaScreen() {
  const [subVista, setSubVista] = useState<'macrociclo' | 'historial'>('macrociclo');
  const [cargando, setCargando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);

  const [telemetria, setTelemetria] = useState<any>({ ftp: 305, peso: 71.0 });
  const [macrociclo, setMacrociclo] = useState<any>({
    objetivo: 'Sin objetivo definido',
    fecha_meta: null,
    disponibilidad: null,
    objetivos_temporada: [],
    total_fases: 0,
    resumen_estrategico: null,
    fase_activa: null,
    fases: [],
  });
  const [actividadesRealizadas, setActividadesRealizadas] = useState<any[]>([]);

  const [dispModalVisible, setDispModalVisible] = useState(false);
  const [objModalVisible, setObjModalVisible] = useState(false);
  const [horasDia, setHorasDia] = useState<Record<string, number>>({
    L: 2,
    M: 2,
    X: 2,
    J: 2,
    V: 0,
    S: 5,
    D: 6,
  });
  const [nuevoObj, setNuevoObj] = useState({
    nombre: '',
    fecha_meta: '2027-06-20',
    prioridad: 'B',
    tipo_evento: 'Gran Fondo',
  });

  const formatearRangoFechas = (inicioStr: string, finStr: string) => {
    const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const d1 = new Date(`${inicioStr}T00:00:00`);
    const d2 = new Date(`${finStr}T00:00:00`);
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return `${inicioStr} – ${finStr}`;
    return `${d1.getDate()} ${meses[d1.getMonth()]} – ${d2.getDate()} ${meses[d2.getMonth()]}`;
  };

  const cargarDatosTemporada = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/calendario?t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.telemetria) setTelemetria(data.telemetria);
      if (data.macrociclo) setMacrociclo(data.macrociclo);
      if (Array.isArray(data.actividades_realizadas)) {
        setActividadesRealizadas(data.actividades_realizadas);
      }
    } catch (e) {
      console.error('Error cargando temporada:', e);
    } finally {
      setCargando(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      cargarDatosTemporada();
    }, [cargarDatosTemporada])
  );

  const sincronizarConIntervals = async () => {
    setSincronizando(true);
    try {
      await fetch(`${API_BASE}/sync`, { method: 'POST' });
      await cargarDatosTemporada();
    } catch (e) {
      console.error(e);
    } finally {
      setSincronizando(false);
    }
  };

  const guardarDisponibilidadBD = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/disponibilidad`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ horas_por_dia: horasDia }),
      });
      if (res.ok) {
        setDispModalVisible(false);
        await cargarDatosTemporada();
        Alert.alert('Disponibilidad Guardada 🕒', 'El Coach IA respetará estos topes diarios.');
      }
    } catch {
      Alert.alert('Error', 'No se pudo guardar la disponibilidad.');
    }
  };

  const guardarNuevoObjetivoBD = async () => {
    if (!nuevoObj.nombre.trim()) {
      Alert.alert('Falta el nombre', 'Escribe el nombre de la prueba o reto.');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/objetivos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nuevoObj),
      });
      if (res.ok) {
        setObjModalVisible(false);
        setNuevoObj({ nombre: '', fecha_meta: '2027-06-20', prioridad: 'B', tipo_evento: 'Gran Fondo' });
        await cargarDatosTemporada();
        Alert.alert('Objetivo Añadido 🎯', 'Ya forma parte de tu temporada.');
      }
    } catch {
      Alert.alert('Error', 'No se pudo guardar el objetivo.');
    }
  };

  const eliminarObjetivoTemporada = async (id: number) => {
    try {
      await fetch(`${API_BASE}/api/objetivos/${id}`, { method: 'DELETE' });
      await cargarDatosTemporada();
    } catch (e) {
      console.error(e);
    }
  };

  if (cargando) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#10b981" />
        <Text style={styles.loadingText}>Cargando planificación de temporada e historial...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* CABECERA */}
      <View style={styles.navbar}>
        <View style={styles.brandRow}>
          <View style={styles.brandIcon}>
            <Text style={{ fontSize: 18 }}>🗺️</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.brandTitle}>
              TEMPORADA <Text style={{ color: '#34d399' }}>& HISTORIAL</Text>
            </Text>
          </View>
        </View>

        {/* Botones de Configuración de Temporada */}
        <View style={styles.actionsBar}>
          <TouchableOpacity style={styles.actionPill} onPress={() => setDispModalVisible(true)}>
            <Text style={styles.actionPillText}>🕒 Disponibilidad L-D</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionPill} onPress={() => setObjModalVisible(true)}>
            <Text style={styles.actionPillText}>🎯 + Añadir Reto A/B/C</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionPillSync} onPress={sincronizarConIntervals} disabled={sincronizando}>
            <Text style={styles.actionPillSyncText}>
              {sincronizando ? 'Sincronizando...' : '🔄 Sync ICU'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={sincronizando} onRefresh={sincronizarConIntervals} tintColor="#10b981" />}
      >
        {/* SELECTOR DE SUB-VISTA: MACROCICLO vs HISTORIAL REALIZADAS */}
        <View style={styles.segmentedSwitch}>
          <TouchableOpacity
            style={[styles.segmentBtn, subVista === 'macrociclo' && styles.segmentBtnActive]}
            onPress={() => setSubVista('macrociclo')}
          >
            <Text style={[styles.segmentBtnText, subVista === 'macrociclo' && styles.segmentBtnTextActive]}>
              🗺️ Macrociclo ({macrociclo.total_fases || 0} Bloques)
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segmentBtn, subVista === 'historial' && styles.segmentBtnActive]}
            onPress={() => setSubVista('historial')}
          >
            <Text style={[styles.segmentBtnText, subVista === 'historial' && styles.segmentBtnTextActive]}>
              ✅ Realizadas ICU ({actividadesRealizadas.length})
            </Text>
          </TouchableOpacity>
        </View>

        {subVista === 'macrociclo' ? (
          <>
            {/* TARJETA DE OBJETIVOS DE LA TEMPORADA */}
            <View style={styles.sectionCard}>
              <Text style={styles.cardOverline}>CALENDARIO DE OBJETIVOS (PRIORIDADES A, B Y C)</Text>
              <Text style={styles.cardMainTitle}>
                {macrociclo.objetivo} {macrociclo.fecha_meta ? `• ${macrociclo.fecha_meta}` : ''}
              </Text>
              {Array.isArray(macrociclo.objetivos_temporada) && macrociclo.objetivos_temporada.length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                  {macrociclo.objetivos_temporada.map((ob: any) => (
                    <TouchableOpacity
                      key={ob.id}
                      onLongPress={() =>
                        Alert.alert('Eliminar Objetivo', `¿Quitar '${ob.nombre}' de la temporada?`, [
                          { text: 'Cancelar', style: 'cancel' },
                          { text: 'Eliminar', style: 'destructive', onPress: () => eliminarObjetivoTemporada(ob.id) },
                        ])
                      }
                      style={styles.objSeasonPill}
                    >
                      <Text style={styles.objSeasonPillText}>
                        [{ob.prioridad}] {ob.nombre} ({ob.fecha_meta})
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <Text style={styles.cardDesc}>
                  Pulsa "+ Añadir Reto A/B/C" arriba o pídele al Coach IA que estructure tu temporada.
                </Text>
              )}
              <Text style={styles.hintDeleteText}>Mantén pulsado un objetivo para eliminarlo.</Text>
            </View>

            {/* DIAGNÓSTICO ESTRATÉGICO DEL DIRECTOR DEPORTIVO */}
            {macrociclo.resumen_estrategico && (
              <View style={styles.estrategiaBox}>
                <Text style={styles.cardOverline}>DIAGNÓSTICO ESTRATÉGICO DEL COACH IA</Text>
                <Text style={styles.estrategiaText}>{macrociclo.resumen_estrategico}</Text>
              </View>
            )}

            {/* LÍNEA TEMPORAL VERTICAL DE BLOQUES DEL MACROCICLO */}
            <View style={styles.sectionCard}>
              <Text style={[styles.cardOverline, { marginBottom: 14 }]}>
                HOJA DE RUTA POR FASES FISIOLÓGICAS
              </Text>

              {macrociclo.fases.length === 0 ? (
                <Text style={styles.cardDesc}>
                  Aún no hay fases generadas. Ve al chat del Coach y pulsa "Estructúrame el plan por bloques para mi objetivo".
                </Text>
              ) : (
                macrociclo.fases.map((fase: any, index: number) => {
                  const esUltima = index === macrociclo.fases.length - 1;
                  const esActiva = fase.estado === 'activa';
                  const esCompletada = fase.estado === 'completada';

                  return (
                    <View key={fase.id || index} style={styles.timelineItemRow}>
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
                            🔥 Bloque Activo • Quedan {fase.dias_restantes} días
                          </Text>
                        )}
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          </>
        ) : (
          /* SUB-VISTA 2: HISTORIAL DE ACTIVIDADES REALIZADAS EN INTERVALS.ICU (SIN BOTONES CORTADOS) */
          <View>
            {actividadesRealizadas.length === 0 ? (
              <View style={styles.sectionCard}>
                <Text style={styles.cardMainTitle}>Sin actividades sincronizadas</Text>
                <Text style={styles.cardDesc}>
                  Pulsa el botón "🔄 Sync ICU" en la barra superior para descargar tus salidas reales desde Intervals.icu.
                </Text>
              </View>
            ) : (
              actividadesRealizadas.map((act) => {
                const fechaObj = new Date(`${act.fecha}T00:00:00`);
                const nombreDia = !isNaN(fechaObj.getTime()) ? DIAS_SEMANA[fechaObj.getDay()] : '';
                const pctFtp = telemetria.ftp > 0 && act.np > 0 ? Math.round((act.np / telemetria.ftp) * 100) : 68;
                const colorZona = pctFtp <= 75 ? '#38bdf8' : pctFtp <= 90 ? '#10b981' : '#f59e0b';

                return (
                  <View key={act.id} style={styles.activityCard}>
                    <View style={styles.activityHeader}>
                      <View style={styles.tssBadgeDone}>
                        <Text style={styles.tssBadgeDoneLabel}>TSS</Text>
                        <Text style={styles.tssBadgeDoneVal}>{act.tss}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.dayNameText}>
                          {nombreDia} • {act.fecha}
                        </Text>
                        <Text style={styles.workoutTitleText}>{act.nombre}</Text>
                      </View>
                      <View style={[styles.intensityPill, { borderColor: colorZona }]}>
                        <Text style={[styles.intensityPillText, { color: colorZona }]}>{pctFtp}% FTP</Text>
                      </View>
                    </View>

                    <View style={styles.metricsGridRow}>
                      <Text style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Tiempo: </Text>
                        <Text style={styles.metricValWhite}>{formatDurationHm(act.duracion_min)}</Text>
                      </Text>
                      <Text style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Dist: </Text>
                        <Text style={styles.metricValWhite}>{act.distancia_km} km</Text>
                      </Text>
                      <Text style={styles.metricItem}>
                        <Text style={styles.metricLabel}>Desnivel: </Text>
                        <Text style={{ color: '#34d399', fontWeight: '800' }}>+{act.desnivel_m} m</Text>
                      </Text>
                      <Text style={styles.metricItem}>
                        <Text style={styles.metricLabel}>NP: </Text>
                        <Text style={{ color: '#38bdf8', fontWeight: '800' }}>{act.np}W</Text>
                      </Text>
                      <Text style={styles.metricItem}>
                        <Text style={styles.metricLabel}>IF: </Text>
                        <Text style={{ color: '#fbbf24', fontWeight: '800' }}>{act.if_val}</Text>
                      </Text>
                      {act.hr_avg > 0 && (
                        <Text style={styles.metricItem}>
                          <Text style={styles.metricLabel}>FC Media: </Text>
                          <Text style={{ color: '#fb7185', fontWeight: '800' }}>{act.hr_avg} bpm</Text>
                        </Text>
                      )}
                      {act.kj > 0 && (
                        <Text style={styles.metricItem}>
                          <Text style={styles.metricLabel}>Trabajo: </Text>
                          <Text style={{ color: '#c084fc', fontWeight: '800' }}>{act.kj} kJ</Text>
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })
            )}
          </View>
        )}
      </ScrollView>

      {/* MODAL DISPONIBILIDAD L-D */}
      <Modal visible={dispModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>🕒 Disponibilidad Semanal (L-D)</Text>
                <Text style={styles.modalSubheader}>Tope de horas por día (0h = Descanso fijo)</Text>
              </View>
              <TouchableOpacity style={styles.closeIconBtn} onPress={() => setDispModalVisible(false)}>
                <Text style={{ color: '#cbd5e1', fontWeight: 'bold' }}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={{ marginTop: 12, gap: 8 }}>
              {DIAS_ORDEN_CONFIG.map((d) => {
                const val = horasDia[d.key] ?? 0;
                return (
                  <View key={d.key} style={styles.dispRow}>
                    <Text style={styles.dispDayLabel}>{d.label}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <TouchableOpacity
                        style={styles.dispStepBtn}
                        onPress={() => setHorasDia((p) => ({ ...p, [d.key]: Math.max(0, (p[d.key] || 0) - 0.5) }))}
                      >
                        <Text style={styles.dispStepBtnText}>−</Text>
                      </TouchableOpacity>
                      <Text style={[styles.dispValText, val === 0 && { color: '#64748b' }]}>
                        {val === 0 ? 'Descanso' : `${val} h`}
                      </Text>
                      <TouchableOpacity
                        style={styles.dispStepBtn}
                        onPress={() => setHorasDia((p) => ({ ...p, [d.key]: Math.min(8, (p[d.key] || 0) + 0.5) }))}
                      >
                        <Text style={styles.dispStepBtnText}>+</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
            </View>

            <TouchableOpacity style={styles.primaryModalBtn} onPress={guardarDisponibilidadBD}>
              <Text style={styles.primaryModalBtnText}>Guardar Disponibilidad</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* MODAL AÑADIR OBJETIVO A/B/C */}
      <Modal visible={objModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>🎯 Añadir Objetivo a la Temporada</Text>
                <Text style={styles.modalSubheader}>Prioridad A (Principal), B (Secundario) o C (Test)</Text>
              </View>
              <TouchableOpacity style={styles.closeIconBtn} onPress={() => setObjModalVisible(false)}>
                <Text style={{ color: '#cbd5e1', fontWeight: 'bold' }}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={{ marginTop: 14, gap: 10 }}>
              <Text style={styles.cardOverline}>NOMBRE DEL RETO O CARRERA</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="Ej: Quebrantahuesos, Everesting, Gran Fondo..."
                placeholderTextColor="#64748b"
                value={nuevoObj.nombre}
                onChangeText={(t) => setNuevoObj((p) => ({ ...p, nombre: t }))}
              />

              <Text style={styles.cardOverline}>FECHA META (YYYY-MM-DD)</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="2027-06-20"
                placeholderTextColor="#64748b"
                value={nuevoObj.fecha_meta}
                onChangeText={(t) => setNuevoObj((p) => ({ ...p, fecha_meta: t }))}
              />

              <Text style={styles.cardOverline}>PRIORIDAD</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['A', 'B', 'C'] as const).map((prio) => (
                  <TouchableOpacity
                    key={prio}
                    style={[styles.prioBtn, nuevoObj.prioridad === prio && styles.prioBtnActive]}
                    onPress={() => setNuevoObj((p) => ({ ...p, prioridad: prio }))}
                  >
                    <Text style={[styles.prioBtnText, nuevoObj.prioridad === prio && { color: '#020617' }]}>
                      Prioridad {prio}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <TouchableOpacity style={styles.primaryModalBtn} onPress={guardarNuevoObjetivoBD}>
              <Text style={styles.primaryModalBtnText}>Guardar Objetivo</Text>
            </TouchableOpacity>
          </View>
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

  actionsBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  actionPill: {
    backgroundColor: '#1e293b',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  actionPillText: { color: '#f8fafc', fontSize: 11, fontWeight: '800' },
  actionPillSync: {
    backgroundColor: 'rgba(14,165,233,0.15)',
    borderColor: '#38bdf8',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    marginLeft: 'auto',
  },
  actionPillSyncText: { color: '#38bdf8', fontSize: 11, fontWeight: '800' },

  segmentedSwitch: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 14,
  },
  segmentBtn: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center' },
  segmentBtnActive: { backgroundColor: '#10b981' },
  segmentBtnText: { fontSize: 12, fontWeight: '800', color: '#94a3b8' },
  segmentBtnTextActive: { color: '#020617', fontWeight: '900' },

  sectionCard: {
    backgroundColor: '#0f172a',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 14,
    marginBottom: 14,
  },
  cardOverline: { fontSize: 10, fontWeight: '900', color: '#34d399', fontFamily: MONO_FONT, letterSpacing: 0.5 },
  cardMainTitle: { fontSize: 17, fontWeight: '900', color: '#ffffff', marginTop: 4 },
  cardDesc: { fontSize: 12.5, color: '#94a3b8', marginTop: 6, lineHeight: 18 },
  hintDeleteText: { fontSize: 10, color: '#64748b', marginTop: 8, fontFamily: MONO_FONT },

  objSeasonPill: {
    backgroundColor: '#020617',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  objSeasonPillText: { fontSize: 11, color: '#38bdf8', fontWeight: '800', fontFamily: MONO_FONT },

  estrategiaBox: {
    backgroundColor: '#0f172a',
    borderColor: 'rgba(16,185,129,0.35)',
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    marginBottom: 14,
  },
  estrategiaText: { fontSize: 13, color: '#e2e8f0', lineHeight: 20, marginTop: 6 },

  timelineItemRow: { flexDirection: 'row', alignItems: 'stretch' },
  timelineLeftCol: { width: 30, alignItems: 'center' },
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
  timelineCircleActive: { borderColor: '#10b981', borderWidth: 3 },
  timelineCircleDone: { backgroundColor: '#10b981', borderColor: '#10b981' },
  timelineInnerDotActive: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#10b981' },
  timelineLine: { width: 2, flex: 1, backgroundColor: '#1e293b', marginVertical: 2 },
  timelineRightCol: { flex: 1, paddingBottom: 20, paddingLeft: 10 },
  timelineCardActive: {
    backgroundColor: 'rgba(16,185,129,0.07)',
    borderColor: 'rgba(16,185,129,0.3)',
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 14,
  },
  timelineDates: { fontSize: 11.5, color: '#94a3b8', fontFamily: MONO_FONT, fontWeight: '700' },
  timelinePhaseTitle: { fontSize: 16, fontWeight: '900', color: '#ffffff', marginTop: 2, marginBottom: 4 },
  timelinePhaseDesc: { fontSize: 12.5, color: '#cbd5e1', lineHeight: 18 },
  timelinePhaseFocus: { fontSize: 11, color: '#fbbf24', fontFamily: MONO_FONT, marginTop: 6, fontWeight: '700' },
  quedanDiasText: { color: '#10b981', fontSize: 11.5, fontWeight: '800', marginTop: 6 },

  activityCard: {
    backgroundColor: '#0f172a',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.35)',
    marginBottom: 12,
    overflow: 'hidden',
  },
  activityHeader: {
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: 1,
    borderColor: '#1e293b',
  },
  tssBadgeDone: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tssBadgeDoneLabel: { fontSize: 8, fontWeight: '900', color: '#020617', fontFamily: MONO_FONT },
  tssBadgeDoneVal: { fontSize: 13, fontWeight: '900', color: '#020617', fontFamily: MONO_FONT },
  dayNameText: { fontSize: 10.5, fontWeight: '800', color: '#34d399', textTransform: 'uppercase' },
  workoutTitleText: { fontSize: 14.5, fontWeight: '800', color: '#ffffff', marginTop: 2 },
  intensityPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    backgroundColor: '#020617',
  },
  intensityPillText: { fontSize: 10, fontWeight: '900', fontFamily: MONO_FONT },
  metricsGridRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#020617',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metricItem: { fontSize: 11, fontFamily: MONO_FONT },
  metricLabel: { color: '#64748b', fontWeight: '700' },
  metricValWhite: { color: '#ffffff', fontWeight: '800' },

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
  dispRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#020617',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  dispDayLabel: { fontSize: 13, fontWeight: '800', color: '#f8fafc' },
  dispStepBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dispStepBtnText: { color: '#38bdf8', fontSize: 16, fontWeight: '900' },
  dispValText: { fontSize: 13, fontWeight: '900', color: '#34d399', width: 70, textAlign: 'center', fontFamily: MONO_FONT },
  modalInput: {
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ffffff',
    fontSize: 13,
  },
  prioBtn: {
    flex: 1,
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  prioBtnActive: { backgroundColor: '#10b981', borderColor: '#34d399' },
  prioBtnText: { color: '#e2e8f0', fontWeight: '800', fontSize: 12 },
  primaryModalBtn: {
    marginTop: 18,
    backgroundColor: '#10b981',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryModalBtnText: { color: '#020617', fontSize: 13, fontWeight: '900' },
});