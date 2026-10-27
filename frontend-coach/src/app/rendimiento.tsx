import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Platform,
} from 'react-native';
import { useFocusEffect } from 'expo-router';

const API_BASE = 'https://ai-cycling-coach-822a.onrender.com';
const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export default function RendimientoScreen() {
  const [stats, setStats] = useState<any>(null);
  const [cargando, setCargando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);

  const cargarStats = useCallback(async () => {
    try {
      setCargando(true);
      const res = await fetch(`${API_BASE}/stats`);
      const data = await res.json();
      setStats(data);
    } catch (error) {
      console.error('Error cargando estadísticas:', error);
    } finally {
      setCargando(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      cargarStats();
    }, [cargarStats])
  );

  const sincronizarIntervals = async () => {
    try {
      setSincronizando(true);
      const res = await fetch(`${API_BASE}/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'success') {
        Alert.alert(
          'Telemetría Sincronizada 🚀',
          `Nuevas actividades: ${data.inserted} | Actualizadas: ${data.updated}`
        );
        await cargarStats();
      } else {
        Alert.alert('Aviso', data.message || 'Usando datos en caché local.');
      }
    } catch (error) {
      Alert.alert('Error de Red', 'No se pudo conectar con el servidor.');
    } finally {
      setSincronizando(false);
    }
  };

  if (cargando && !stats) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#10b981" />
        <Text style={styles.loadingText}>Calculando curvas CTL, ATL y TSB...</Text>
      </View>
    );
  }

  const ctl = stats?.fitness_ctl ?? 0;
  const atl = stats?.fatiga_atl ?? 0;
  const tsb = stats?.frescura_tsb ?? 0;
  const ftp = stats?.ftp_actual || 305;
  const peso = stats?.peso_actual || 71.0;
  const wkg = stats?.wkg_actual ? Number(stats.wkg_actual).toFixed(2) : (ftp / peso).toFixed(2);

  const graficaCtl: { value: number; label: string }[] = stats?.grafica_ctl || [];
  const graficaAtl: { value: number; label: string }[] = stats?.grafica_atl || [];
  const puntosGrafica = graficaCtl.slice(-10).map((item, idx) => {
    const atlMatch = graficaAtl.slice(-10)[idx];
    return {
      label: item.label,
      ctl: item.value,
      atl: atlMatch ? atlMatch.value : 0,
    };
  });
  const maxValorGrafica = Math.max(
    100,
    ...puntosGrafica.map((p) => Math.max(p.ctl, p.atl))
  );

  return (
    <View style={styles.container}>
      {/* TOP NAVBAR CORREGIDA */}
      <View style={styles.navbar}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 48 }}>
          <View style={styles.brandIcon}>
            <Text style={{ fontSize: 17 }}>📈</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.brandTitle}>
                VELO<Text style={{ color: '#34d399' }}>COACH</Text>
              </Text>
              <View style={styles.proBadge}>
                <Text style={styles.proBadgeText}>PMC LAB</Text>
              </View>
            </View>
            <Text style={styles.brandSubtitle} numberOfLines={1}>
              Carga Crónica (CTL), Aguda (ATL) y Frescura
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.syncBtn, { marginTop: 10, alignItems: 'center' }]}
          onPress={sincronizarIntervals}
          disabled={sincronizando}
        >
          <Text style={styles.syncBtnText}>
            {sincronizando ? '⏳ Sincronizando actividades...' : '🔄 Sincronizar con Intervals.icu'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {stats?.error ? (
          <View style={styles.panel}>
            <Text style={styles.errorText}>{stats.error}</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={sincronizarIntervals}>
              <Text style={styles.primaryBtnText}>Sincronizar con Intervals.icu ahora</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* 4 TARJETAS KPI DE TELEMETRÍA FISIOLÓGICA */}
            <View style={styles.kpiGrid}>
              <View style={[styles.kpiCard, { borderColor: 'rgba(14,165,233,0.35)' }]}>
                <Text style={[styles.kpiLabel, { color: '#38bdf8' }]}>📈 FITNESS (CTL)</Text>
                <Text style={styles.kpiVal}>{ctl}</Text>
                <Text style={styles.kpiSub}>Carga Crónica (42 días)</Text>
              </View>

              <View style={[styles.kpiCard, { borderColor: 'rgba(244,63,94,0.35)' }]}>
                <Text style={[styles.kpiLabel, { color: '#fb7185' }]}>🔥 FATIGA (ATL)</Text>
                <Text style={styles.kpiVal}>{atl}</Text>
                <Text style={styles.kpiSub}>Carga Aguda (7 días)</Text>
              </View>

              <View style={[styles.kpiCard, { borderColor: 'rgba(16,185,129,0.35)' }]}>
                <Text style={[styles.kpiLabel, { color: '#34d399' }]}>🔋 FRESCURA (TSB)</Text>
                <Text
                  style={[
                    styles.kpiVal,
                    { color: tsb < -25 ? '#fb7185' : tsb <= 5 ? '#34d399' : '#fbbf24' },
                  ]}
                >
                  {tsb > 0 ? `+${tsb}` : tsb}
                </Text>
                <Text style={styles.kpiSub}>
                  {tsb < -25 ? 'Riesgo Sobrecarga' : tsb <= 5 ? 'Zona Óptima Entreno' : 'Fresco / Tapering'}
                </Text>
              </View>

              <View style={[styles.kpiCard, { borderColor: 'rgba(245,158,11,0.35)' }]}>
                <Text style={[styles.kpiLabel, { color: '#fbbf24' }]}>⚡ FTP VALIDADO</Text>
                <Text style={[styles.kpiVal, { color: '#fbbf24' }]}>{ftp}W</Text>
                <Text style={styles.kpiSub}>{wkg} W/kg @ Umbral</Text>
              </View>
            </View>

            {/* GRÁFICA PMC (CTL vs ATL ÚLTIMOS 30 DÍAS) */}
            <View style={styles.panel}>
              <View style={styles.panelHeaderRow}>
                <View>
                  <Text style={styles.panelTitle}>Curva de Rendimiento (PMC)</Text>
                  <Text style={styles.panelSubtitle}>Comparativa Fitness (CTL) vs Fatiga (ATL)</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Text style={styles.legendCtl}>● CTL</Text>
                  <Text style={styles.legendAtl}>● ATL</Text>
                </View>
              </View>

              <View style={styles.chartContainer}>
                {puntosGrafica.map((pt, index) => {
                  const hCtl = Math.max(10, Math.round((pt.ctl / maxValorGrafica) * 100));
                  const hAtl = Math.max(10, Math.round((pt.atl / maxValorGrafica) * 100));
                  return (
                    <View key={index} style={styles.chartCol}>
                      <View style={styles.barsPair}>
                        <View style={[styles.barCtl, { height: `${hCtl}%` }]} />
                        <View style={[styles.barAtl, { height: `${hAtl}%` }]} />
                      </View>
                      <Text style={styles.chartLabel}>{pt.label}</Text>
                    </View>
                  );
                })}
              </View>
            </View>

            {/* DIAGNÓSTICO FISIOLÓGICO DEL COACH IA */}
            <View style={styles.panel}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Text style={{ fontSize: 16 }}>🔬</Text>
                <Text style={[styles.panelTitle, { color: '#34d399' }]}>
                  Diagnóstico Fisiológico IA
                </Text>
              </View>
              <Text style={styles.aiExplanationText}>{stats?.explicacion_ia}</Text>
            </View>
          </>
        )}
      </ScrollView>
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
  brandIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandTitle: { fontSize: 17, fontWeight: '900', color: '#ffffff' },
  proBadge: {
    backgroundColor: 'rgba(14,165,233,0.15)',
    borderColor: 'rgba(14,165,233,0.35)',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  proBadgeText: { color: '#38bdf8', fontSize: 9, fontWeight: '800', fontFamily: MONO_FONT },
  brandSubtitle: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  syncBtn: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderColor: 'rgba(16,185,129,0.4)',
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 10,
  },
  syncBtnText: { color: '#34d399', fontSize: 11, fontWeight: '800' },

  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 },
  kpiCard: {
    width: '48.3%',
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderRadius: 16,
    padding: 13,
  },
  kpiLabel: { fontSize: 10, fontWeight: '800' },
  kpiVal: { fontSize: 24, fontWeight: '900', color: '#ffffff', fontFamily: MONO_FONT, marginTop: 4 },
  kpiSub: { fontSize: 10, color: '#94a3b8', marginTop: 3, fontFamily: MONO_FONT },

  panel: {
    backgroundColor: '#0f172a',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 20,
    padding: 15,
    marginBottom: 14,
  },
  panelHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  panelTitle: { fontSize: 15, fontWeight: '800', color: '#ffffff' },
  panelSubtitle: { fontSize: 11, color: '#94a3b8', marginTop: 2 },
  legendCtl: { fontSize: 11, fontWeight: '800', color: '#38bdf8', fontFamily: MONO_FONT },
  legendAtl: { fontSize: 11, fontWeight: '800', color: '#fb7185', fontFamily: MONO_FONT },

  chartContainer: {
    height: 150,
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  chartCol: { flex: 1, alignItems: 'center', height: '100%', justifyContent: 'flex-end' },
  barsPair: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: '82%',
    width: '72%',
  },
  barCtl: { flex: 1, backgroundColor: '#0ea5e9', borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  barAtl: { flex: 1, backgroundColor: '#f43f5e', borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  chartLabel: { fontSize: 8, color: '#64748b', fontFamily: MONO_FONT, marginTop: 4 },

  aiExplanationText: { fontSize: 13, color: '#cbd5e1', lineHeight: 20 },
  errorText: { fontSize: 13, color: '#fb7185', marginBottom: 12, textAlign: 'center' },
  primaryBtn: {
    backgroundColor: '#10b981',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#020617', fontWeight: '900', fontSize: 13 },
});