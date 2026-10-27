import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LineChart } from 'react-native-gifted-charts';
import { Ionicons } from '@expo/vector-icons';

const screenWidth = Dimensions.get('window').width;
const API_BASE = 'https://ai-cycling-coach-822a.onrender.com';

const POWER_ZONES = [
  { z: 'Z1', name: 'Recuperación Activa', minPct: 0, maxPct: 55, color: '#94a3b8' },
  { z: 'Z2', name: 'Resistencia Aeróbica (FatMax)', minPct: 56, maxPct: 75, color: '#38bdf8' },
  { z: 'Z3', name: 'Tempo / Fuerza-Resistencia', minPct: 76, maxPct: 90, color: '#10b981' },
  { z: 'SS', name: 'Sweet Spot (Sub-Umbral)', minPct: 88, maxPct: 94, color: '#84cc16' },
  { z: 'Z4', name: 'Umbral de Lactato (FTP)', minPct: 91, maxPct: 105, color: '#f59e0b' },
  { z: 'Z5', name: 'VO2 Máx (Capacidad Aeróbica)', minPct: 106, maxPct: 120, color: '#f97316' },
  { z: 'Z6', name: 'Capacidad Anaeróbica', minPct: 121, maxPct: 150, color: '#ef4444' },
];

export default function RendimientoScreen() {
  const [stats, setStats] = useState<any>(null);
  const [cargando, setCargando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);

  const cargarEstadisticas = async () => {
    try {
      const res = await fetch(`${API_BASE}/stats?t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json();
      setStats(data);
    } catch (error) {
      console.error('Error cargando estadísticas:', error);
    } finally {
      setCargando(false);
    }
  };

  const sincronizarConIntervals = async () => {
    setSincronizando(true);
    try {
      await fetch(`${API_BASE}/sync`, { method: 'POST' });
      await cargarEstadisticas();
    } catch (error) {
      console.error('Error sincronizando:', error);
    } finally {
      setSincronizando(false);
    }
  };

  useEffect(() => {
    cargarEstadisticas();
  }, []);

  if (cargando) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#38bdf8" />
        <Text style={styles.loadingText}>Calculando curva PMC, niveles por zona y Wellness...</Text>
      </View>
    );
  }

  const ctl = stats?.fitness_ctl ?? 0;
  const atl = stats?.fatiga_atl ?? 0;
  const tsb = stats?.frescura_tsb ?? 0;
  const ftp = stats?.ftp_actual || 305;
  const peso = stats?.peso_actual || 71.0;
  const wkg = stats?.wkg_actual ? Number(stats.wkg_actual).toFixed(2) : (ftp / peso).toFixed(2);
  const niveles = stats?.niveles_progresion || {
    resistencia_z2: 4.5,
    tempo_torque: 4.0,
    sweet_spot: 4.5,
    umbral_ftp: 4.2,
    vo2max: 3.8,
    durabilidad_kj: 4.1,
    distribucion: { z1_z2_pct: 78, z3_z4_pct: 15, z5_pct: 7, modelo: 'Piramidal Científico' },
  };

  const tsbState =
    tsb > 15
      ? { label: 'Transición / Pérdida carga', color: '#94a3b8' }
      : tsb >= 5
      ? { label: 'Frescura Óptima (Tapering / Pico)', color: '#10b981' }
      : tsb >= -10
      ? { label: 'Zona Neutra de Mantenimiento', color: '#38bdf8' }
      : tsb >= -25
      ? { label: 'Sobrecarga Productiva Óptima', color: '#f59e0b' }
      : { label: 'Riesgo de Sobreentrenamiento', color: '#ef4444' };

  const NIVELES_ITEMS = [
    { label: 'Resistencia Z2 / FatMax', val: niveles.resistencia_z2, color: '#38bdf8' },
    { label: 'Fuerza-Resistencia / Torque', val: niveles.tempo_torque, color: '#10b981' },
    { label: 'Sweet Spot (88-94% FTP)', val: niveles.sweet_spot, color: '#84cc16' },
    { label: 'Umbral de Lactato (FTP)', val: niveles.umbral_ftp, color: '#f59e0b' },
    { label: 'Capacidad Aeróbica (VO2max)', val: niveles.vo2max, color: '#f97316' },
    { label: 'Durabilidad (>2.000 kJ)', val: niveles.durabilidad_kj, color: '#a855f7' },
  ];

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: 110 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={sincronizando} onRefresh={sincronizarConIntervals} tintColor="#38bdf8" />}
      >
        {/* CABECERA */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.eyebrow}>PERFORMANCE LAB</Text>
            <Text style={styles.headerTitle}>Fisiología y Carga</Text>
          </View>
          <TouchableOpacity style={styles.syncBtn} onPress={sincronizarConIntervals} disabled={sincronizando}>
            {sincronizando ? (
              <ActivityIndicator size="small" color="#042f2e" />
            ) : (
              <>
                <Ionicons name="sync" size={16} color="#042f2e" />
                <Text style={styles.syncBtnText}>Sync ICU</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* TARJETA DE PERFIL DE POTENCIA Y WELLNESS */}
        <View style={styles.profileBanner}>
          <View style={styles.profileMain}>
            <Text style={styles.profileLabel}>FTP VALIDADO</Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <Text style={styles.profileFtp}>{ftp}W</Text>
              <Text style={styles.profileWkg}>{wkg} W/kg</Text>
            </View>
            <Text style={styles.profileSub}>
              Peso: {peso} kg • LTHR: {stats?.lthr_actual || 178} bpm • FC Máx: {stats?.max_hr_actual || 200} bpm
            </Text>
          </View>
          <View style={styles.tsbBadgeBox}>
            <Text style={styles.tsbBadgeTitle}>ESTADO FISIOLÓGICO</Text>
            <View style={[styles.tsbPill, { borderColor: tsbState.color }]}>
              <View style={[styles.tsbDot, { backgroundColor: tsbState.color }]} />
              <Text style={[styles.tsbPillText, { color: tsbState.color }]}>{tsbState.label}</Text>
            </View>
            {(stats?.hrv_actual || stats?.sleep_hours || stats?.resting_hr) && (
              <Text style={[styles.profileSub, { marginTop: 6 }]}>
                {stats?.hrv_actual ? `HRV: ${stats.hrv_actual}ms ` : ''}
                {stats?.resting_hr ? `• FC Rep: ${stats.resting_hr}bpm ` : ''}
                {stats?.sleep_hours ? `• Sueño: ${stats.sleep_hours}h` : ''}
              </Text>
            )}
          </View>
        </View>

        {/* TARJETAS PMC (CTL, ATL, TSB) */}
        <View style={styles.kpiRow}>
          <View style={[styles.kpiCard, { borderTopColor: '#38bdf8' }]}>
            <Text style={styles.kpiTitle}>FITNESS (CTL)</Text>
            <Text style={[styles.kpiValue, { color: '#38bdf8' }]}>{ctl}</Text>
            <Text style={styles.kpiSub}>Carga crónica 42d</Text>
          </View>
          <View style={[styles.kpiCard, { borderTopColor: '#f43f5e' }]}>
            <Text style={styles.kpiTitle}>FATIGA (ATL)</Text>
            <Text style={[styles.kpiValue, { color: '#f43f5e' }]}>{atl}</Text>
            <Text style={styles.kpiSub}>Estrés agudo 7d</Text>
          </View>
          <View style={[styles.kpiCard, { borderTopColor: tsbState.color }]}>
            <Text style={styles.kpiTitle}>FORMA (TSB)</Text>
            <Text style={[styles.kpiValue, { color: tsbState.color }]}>{tsb > 0 ? `+${tsb}` : tsb}</Text>
            <Text style={styles.kpiSub}>Balance frescura</Text>
          </View>
        </View>

        {/* NIVELES DE PROGRESIÓN POR ZONA (TRAINERROAD / XERT STYLE) */}
        <View style={styles.zonesCard}>
          <View style={styles.cardHeaderInline}>
            <Ionicons name="cellular" size={18} color="#10b981" />
            <Text style={styles.cardTitle}>Niveles de Progresión Fisiológica (1.0 - 10.0)</Text>
          </View>
          <Text style={styles.zonesSubtitle}>
            Calculados dinámicamente por el motor IA según tus entrenamientos de los últimos 60 días y distribución{' '}
            <Text style={{ color: '#38bdf8', fontWeight: '800' }}>{niveles?.distribucion?.modelo}</Text> (
            {niveles?.distribucion?.z1_z2_pct}% Z1-Z2 / {niveles?.distribucion?.z3_z4_pct}% Z3-Z4 /{' '}
            {niveles?.distribucion?.z5_pct}% Z5+).
          </Text>

          {NIVELES_ITEMS.map((item) => (
            <View key={item.label} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ color: '#e2e8f0', fontSize: 12, fontWeight: '700' }}>{item.label}</Text>
                <Text style={{ color: item.color, fontSize: 12, fontWeight: '900' }}>Nivel {item.val}</Text>
              </View>
              <View style={{ height: 8, backgroundColor: '#1e293b', borderRadius: 6, overflow: 'hidden' }}>
                <View
                  style={{
                    width: `${Math.min(100, Math.max(10, Number(item.val) * 10))}%`,
                    height: '100%',
                    backgroundColor: item.color,
                    borderRadius: 6,
                  }}
                />
              </View>
            </View>
          ))}
        </View>

        {/* GRÁFICA PMC AJUSTADA AL 100% DE LA TARJETA */}
        <View style={styles.chartCard}>
          <View style={styles.chartHeader}>
            <Text style={styles.cardTitle}>Curva de Gestión de Rendimiento (PMC)</Text>
            <View style={styles.legendRow}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: '#38bdf8' }]} />
                <Text style={styles.legendText}>CTL (Fitness)</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: '#f43f5e' }]} />
                <Text style={styles.legendText}>ATL (Fatiga)</Text>
              </View>
            </View>
          </View>

          {stats?.grafica_ctl && stats.grafica_ctl.length > 0 ? (
            <View style={{ overflow: 'hidden', alignItems: 'center' }}>
              <LineChart
                data={stats.grafica_ctl}
                data2={stats.grafica_atl}
                height={185}
                width={screenWidth - 84}
                spacing={Math.max(18, Math.floor((screenWidth - 105) / Math.max(1, stats.grafica_ctl.length)))}
                initialSpacing={10}
                endSpacing={10}
                color1="#38bdf8"
                color2="#f43f5e"
                textColor1="#94a3b8"
                dataPointsColor1="#38bdf8"
                dataPointsColor2="#f43f5e"
                thickness={2.5}
                hideRules
                yAxisColor="#1e293b"
                xAxisColor="#1e293b"
                yAxisTextStyle={{ color: '#64748b', fontSize: 10 }}
                xAxisLabelTextStyle={{ color: '#64748b', fontSize: 8 }}
                curved
                areaChart
                startFillColor1="#38bdf8"
                startOpacity1={0.22}
                endOpacity1={0.0}
                startFillColor2="#f43f5e"
                startOpacity2={0.14}
                endOpacity2={0.0}
              />
            </View>
          ) : (
            <Text style={styles.noDataText}>Sincroniza con Intervals.icu para visualizar la curva PMC.</Text>
          )}
        </View>

        {/* TABLA DE ZONAS DE POTENCIA COGGAN */}
        <View style={styles.zonesCard}>
          <View style={styles.cardHeaderInline}>
            <Ionicons name="flash" size={18} color="#f59e0b" />
            <Text style={styles.cardTitle}>Zonas de Potencia Activas (Base {ftp}W)</Text>
          </View>

          {POWER_ZONES.map((z) => {
            const minW = Math.round((ftp * z.minPct) / 100);
            const maxW = Math.round((ftp * z.maxPct) / 100);
            return (
              <View key={z.z} style={styles.zoneRow}>
                <View style={[styles.zoneBadge, { backgroundColor: z.color }]}>
                  <Text style={styles.zoneBadgeText}>{z.z}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.zoneName}>{z.name}</Text>
                  <Text style={styles.zonePct}>
                    {z.minPct}% - {z.maxPct}% FTP
                  </Text>
                </View>
                <Text style={styles.zoneWatts}>
                  {minW} - {maxW} W
                </Text>
              </View>
            );
          })}
        </View>

        {/* DIAGNÓSTICO DEL ENTRENADOR IA */}
        <View style={styles.aiCard}>
          <View style={styles.cardHeaderInline}>
            <Ionicons name="analytics" size={18} color="#10b981" />
            <Text style={[styles.cardTitle, { color: '#10b981' }]}>Diagnóstico Fisiológico IA</Text>
          </View>
          <Text style={styles.aiText}>{stats?.explicacion_ia || 'Sin análisis disponible.'}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#060b14' },
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 10 },
  loadingContainer: { flex: 1, backgroundColor: '#060b14', justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: '#38bdf8', marginTop: 12, fontSize: 14, fontWeight: '600' },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  eyebrow: { color: '#38bdf8', fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  headerTitle: { color: '#f8fafc', fontSize: 24, fontWeight: '900' },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#38bdf8',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
  },
  syncBtnText: { color: '#042f2e', fontWeight: '900', fontSize: 12 },

  profileBanner: {
    backgroundColor: '#0f172a',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  profileMain: { flex: 1, minWidth: 170 },
  profileLabel: { color: '#64748b', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  profileFtp: { color: '#f8fafc', fontSize: 30, fontWeight: '900' },
  profileWkg: { color: '#10b981', fontSize: 16, fontWeight: '800' },
  profileSub: { color: '#94a3b8', fontSize: 11, marginTop: 2 },
  tsbBadgeBox: { alignItems: 'flex-end' },
  tsbBadgeTitle: { color: '#64748b', fontSize: 9, fontWeight: '800', marginBottom: 4, letterSpacing: 0.8 },
  tsbPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    backgroundColor: '#060b14',
  },
  tsbDot: { width: 7, height: 7, borderRadius: 4 },
  tsbPillText: { fontSize: 11, fontWeight: '800' },

  kpiRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginBottom: 14 },
  kpiCard: {
    flex: 1,
    backgroundColor: '#0f172a',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
    borderTopWidth: 3,
    alignItems: 'center',
  },
  kpiTitle: { color: '#94a3b8', fontSize: 10, fontWeight: '800' },
  kpiValue: { fontSize: 24, fontWeight: '900', marginVertical: 4 },
  kpiSub: { color: '#64748b', fontSize: 10 },

  chartCard: {
    backgroundColor: '#0f172a',
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 14,
    overflow: 'hidden',
  },
  chartHeader: {
    flexDirection: 'column',
    gap: 6,
    marginBottom: 12,
  },
  cardTitle: { color: '#f8fafc', fontSize: 15, fontWeight: '300' },
  legendRow: { flexDirection: 'row', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: '#94a3b8', fontSize: 11, fontWeight: '700' },
  noDataText: { color: '#64748b', textAlign: 'center', marginVertical: 20 },

  zonesCard: {
    backgroundColor: '#0f172a',
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 14,
  },
  cardHeaderInline: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  zonesSubtitle: { color: '#64748b', fontSize: 11, marginBottom: 14, lineHeight: 16 },
  zoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    gap: 10,
  },
  zoneBadge: { width: 32, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  zoneBadgeText: { color: '#060b14', fontWeight: '900', fontSize: 11 },
  zoneName: { color: '#e2e8f0', fontSize: 12, fontWeight: '700' },
  zonePct: { color: '#64748b', fontSize: 10 },
  zoneWatts: { color: '#f8fafc', fontSize: 13, fontWeight: '900' },

  aiCard: {
    backgroundColor: '#0f172a',
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#064e3b',
  },
  aiText: { color: '#cbd5e1', fontSize: 13.5, lineHeight: 21 },
});