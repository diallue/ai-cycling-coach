import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Alert,
  Platform,
  KeyboardAvoidingView,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  API_BASE_URL,
  UsuarioAuth,
  getAuthUser,
  guardarSesionLocal,
  cerrarSesionLocal,
  suscribirAuth,
} from '../constants/auth';

const MONO_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export default function PerfilScreen() {
  const [usuario, setUsuario] = useState<UsuarioAuth | null>(getAuthUser());
  const [cargando, setCargando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);

  // Estado OAuth2 Intervals.icu
  const [esperandoOAuth, setEsperandoOAuth] = useState(false);
  const pollTimerRef = useRef<any>(null);

  // Estado Login / Registro cuando no hay sesión iniciada
  const [modoAcceso, setModoAcceso] = useState<'oauth' | 'login' | 'registro'>('oauth');
  const [email, setEmail] = useState('diego@allue.com');
  const [password, setPassword] = useState('');
  const [nombreRegistro, setNombreRegistro] = useState('');

  // Estado Edición de Perfil cuando el usuario YA está dentro
  const [editNombre, setEditNombre] = useState('');
  const [editFtp, setEditFtp] = useState('305');
  const [editPeso, setEditPeso] = useState('71');
  const [editLthr, setEditLthr] = useState('178');
  const [editMaxHr, setEditMaxHr] = useState('200');
  const [editAthId, setEditAthId] = useState('');
  const [editApiKey, setEditApiKey] = useState('');
  const [mostrarClavesManuales, setMostrarClavesManuales] = useState(false);

  useEffect(() => {
    const actualizar = () => {
      const u = getAuthUser();
      setUsuario(u);
      if (u) {
        setEditNombre(u.nombre || '');
        setEditFtp(String(u.ftp_actual || 250));
        setEditPeso(String(u.peso_actual || 70));
        setEditLthr(String(u.lthr || 175));
        setEditMaxHr(String(u.max_hr || 195));
        setEditAthId(u.intervals_athlete_id || '');
        setEditApiKey('');
      }
    };
    actualizar();
    const desuscribir = suscribirAuth(actualizar);
    return () => {
      desuscribir();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // ==========================================================================
  // 1. FLUJO OAUTH2 EN UN CLIC CON INTERVALS.ICU
  // ==========================================================================
  const iniciarOAuthConIntervals = async () => {
    try {
      setCargando(true);
      const res = await fetch(`${API_BASE_URL}/api/auth/intervals/login-url`);
      const data = await res.json();

      if (!data.oauth_configurado) {
        Alert.alert(
          'Falta Client ID en Render',
          'Añade INTERVALS_CLIENT_ID e INTERVALS_CLIENT_SECRET en las variables de entorno de Render, o usa la pestaña de acceso directo mientras tanto.',
          [
            { text: 'Solicitar en Intervals.icu', onPress: () => Linking.openURL('https://intervals.icu/oauth/apply') },
            { text: 'Usar acceso directo', onPress: () => setModoAcceso('login') },
          ]
        );
        return;
      }

      setEsperandoOAuth(true);
      await Linking.openURL(data.authorize_url);

      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`${API_BASE_URL}/api/auth/intervals/poll/${data.state}`);
          const pollData = await pollRes.json();
          if (pollData.status === 'completed' && pollData.token && pollData.usuario) {
            clearInterval(pollTimerRef.current);
            setEsperandoOAuth(false);
            await fetch(`${API_BASE_URL}/sync`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${pollData.token}` },
            }).catch(() => {});
            await guardarSesionLocal(pollData.token, pollData.usuario);
          } else if (pollData.status === 'error') {
            clearInterval(pollTimerRef.current);
            setEsperandoOAuth(false);
            Alert.alert('Autorización cancelada', pollData.detail || 'No se completó la vinculación.');
          }
        } catch {}
      }, 2000);
    } catch {
      Alert.alert('Error', 'No se pudo conectar con el servidor en Render.');
    } finally {
      setCargando(false);
    }
  };

  // ==========================================================================
  // 2. FLUJO DE LOGIN / REGISTRO CON EMAIL Y CLAVE DE INTERVALS
  // ==========================================================================
  const ejecutarLoginORegistro = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Campos requeridos', 'Introduce tu email y contraseña.');
      return;
    }
    setCargando(true);
    try {
      const esRegistro = modoAcceso === 'registro';
      const endpoint = esRegistro ? '/api/auth/register' : '/api/auth/login';
      const body = esRegistro
        ? {
            nombre: nombreRegistro.trim() || 'Ciclista',
            email: email.trim(),
            password: password.trim(),
            ftp_actual: Number(editFtp) || 250,
            peso_actual: Number(editPeso) || 70,
            intervals_athlete_id: editAthId.trim() || null,
            intervals_api_key: editApiKey.trim() || null,
          }
        : { email: email.trim(), password: password.trim() };

      const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        Alert.alert('Error de acceso', data.detail || 'No se pudo iniciar sesión.');
        return;
      }
      await guardarSesionLocal(data.token, data.usuario);
    } catch {
      Alert.alert('Error de conexión', 'No se pudo contactar con el servidor.');
    } finally {
      setCargando(false);
    }
  };

  // ==========================================================================
  // 3. GUARDAR PERFIL Y SINCRONIZAR ACTIVIDADES
  // ==========================================================================
  const guardarCambiosPerfil = async () => {
    try {
      setCargando(true);
      const res = await fetch(`${API_BASE_URL}/api/auth/perfil`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: editNombre,
          ftp_actual: Number(editFtp) || 250,
          peso_actual: Number(editPeso) || 70,
          lthr: Number(editLthr) || 175,
          max_hr: Number(editMaxHr) || 195,
          intervals_athlete_id: editAthId,
          intervals_api_key: editApiKey || null,
        }),
      });
      const data = await res.json();
      if (res.ok && data.usuario) {
        setUsuario(data.usuario);
        setEditApiKey('');
        Alert.alert('Perfil Guardado ✅', 'Tus zonas fisiológicas y conexión con Intervals.icu se han actualizado.');
      }
    } catch {
      Alert.alert('Error', 'No se pudo guardar el perfil.');
    } finally {
      setCargando(false);
    }
  };

  const sincronizarAhora = async () => {
    setSincronizando(true);
    try {
      const res = await fetch(`${API_BASE_URL}/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'success') {
        Alert.alert(
          'Sincronización Completada ☁️',
          `Se han procesado ${data.total_processed} actividades (${data.inserted} nuevas).`
        );
      } else {
        Alert.alert('Aviso', data.message || 'Verifica tu conexión con Intervals.icu.');
      }
    } catch {
      Alert.alert('Error', 'Fallo al sincronizar con Intervals.icu.');
    } finally {
      setSincronizando(false);
    }
  };

  // ==========================================================================
  // VISTA A: PANTALLA DE BIENVENIDA E INICIO DE SESIÓN (CUANDO NO HAY SESIÓN)
  // ==========================================================================
  if (!usuario) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
            <View style={styles.heroHeader}>
              <View style={styles.logoBadge}>
                <Text style={{ fontSize: 30 }}>🚴‍♂️</Text>
              </View>
              <Text style={styles.authBrand}>
                VELO<Text style={{ color: '#10b981' }}>COACH</Text> PRO
              </Text>
              <Text style={styles.authSubtitle}>
                Entrenador IA conectado en tiempo real a tu fisiología y a tu cuenta de Intervals.icu
              </Text>
            </View>

            {/* SELECTOR DE MODO DE ACCESO EN 3 PESTAÑAS CÓMODAS */}
            <View style={styles.segmentedBar}>
              <TouchableOpacity
                style={[styles.segmentItem, modoAcceso === 'oauth' && styles.segmentItemActive]}
                onPress={() => setModoAcceso('oauth')}
              >
                <Text style={[styles.segmentText, modoAcceso === 'oauth' && styles.segmentTextActive]}>
                  ⚡ Intervals.icu
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentItem, modoAcceso === 'login' && styles.segmentItemActive]}
                onPress={() => setModoAcceso('login')}
              >
                <Text style={[styles.segmentText, modoAcceso === 'login' && styles.segmentTextActive]}>
                  Iniciar Sesión
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentItem, modoAcceso === 'registro' && styles.segmentItemActive]}
                onPress={() => setModoAcceso('registro')}
              >
                <Text style={[styles.segmentText, modoAcceso === 'registro' && styles.segmentTextActive]}>
                  Nueva Cuenta
                </Text>
              </TouchableOpacity>
            </View>

            {modoAcceso === 'oauth' && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Conexión Automática Oficial</Text>
                <Text style={styles.cardDesc}>
                  Inicia sesión directamente con tu cuenta de Intervals.icu. Importaremos tu FTP, peso, historial de salidas y enviaremos tus entrenamientos al Garmin o Wahoo sin pedirte claves manuales.
                </Text>

                {esperandoOAuth ? (
                  <View style={styles.oauthWaitingBox}>
                    <ActivityIndicator size="large" color="#38bdf8" />
                    <Text style={styles.oauthWaitingTitle}>Esperando confirmación en Intervals.icu...</Text>
                    <Text style={styles.oauthWaitingSub}>
                      Acepta el permiso en el navegador y entrarás automáticamente a tu panel.
                    </Text>
                    <TouchableOpacity
                      style={styles.cancelOAuthBtn}
                      onPress={() => {
                        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
                        setEsperandoOAuth(false);
                      }}
                    >
                      <Text style={styles.cancelOAuthText}>Cancelar espera</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <TouchableOpacity
                      style={styles.intervalsPrimaryBtn}
                      onPress={iniciarOAuthConIntervals}
                      disabled={cargando}
                    >
                      <Ionicons name="flash" size={20} color="#020617" />
                      <Text style={styles.intervalsPrimaryBtnText}>
                        Conectar con mi cuenta de Intervals.icu
                      </Text>
                    </TouchableOpacity>

                    <View style={styles.dividerRow}>
                      <View style={styles.dividerLine} />
                      <Text style={styles.dividerText}>¿NUEVO EN INTERVALS.ICU?</Text>
                      <View style={styles.dividerLine} />
                    </View>

                    <TouchableOpacity
                      style={styles.intervalsSignupBtn}
                      onPress={() => Linking.openURL('https://intervals.icu/')}
                    >
                      <Ionicons name="open-outline" size={16} color="#38bdf8" />
                      <Text style={styles.intervalsSignupBtnText}>
                        Crear cuenta gratis en Intervals.icu y vincular Garmin/Strava
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}

            {modoAcceso === 'login' && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Acceso con Email</Text>
                <Text style={styles.cardDesc}>
                  Entra con tu cuenta de VeloCoach Pro ya vinculada.
                </Text>

                <Text style={styles.inputLabel}>EMAIL</Text>
                <TextInput
                  style={styles.input}
                  placeholder="tu@email.com"
                  placeholderTextColor="#64748b"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={email}
                  onChangeText={setEmail}
                />

                <Text style={styles.inputLabel}>CONTRASEÑA</Text>
                <TextInput
                  style={styles.input}
                  placeholder="••••••••"
                  placeholderTextColor="#64748b"
                  secureTextEntry
                  value={password}
                  onChangeText={setPassword}
                />

                <TouchableOpacity style={styles.primaryBtn} onPress={ejecutarLoginORegistro} disabled={cargando}>
                  {cargando ? (
                    <ActivityIndicator color="#020617" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Entrar a VeloCoach Pro</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {modoAcceso === 'registro' && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Registro Rápido de Ciclista</Text>
                <Text style={styles.cardDesc}>
                  Crea tu perfil independiente. Puedes vincular Intervals.icu ahora o más adelante desde tu pestaña de Perfil.
                </Text>

                <Text style={styles.inputLabel}>NOMBRE COMPLETO</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Ej: Santiago Allue"
                  placeholderTextColor="#64748b"
                  value={nombreRegistro}
                  onChangeText={setNombreRegistro}
                />

                <Text style={styles.inputLabel}>EMAIL</Text>
                <TextInput
                  style={styles.input}
                  placeholder="tu@email.com"
                  placeholderTextColor="#64748b"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={email}
                  onChangeText={setEmail}
                />

                <Text style={styles.inputLabel}>CONTRASEÑA</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Mínimo 4 caracteres"
                  placeholderTextColor="#64748b"
                  secureTextEntry
                  value={password}
                  onChangeText={setPassword}
                />

                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>FTP ESTIMADO (W)</Text>
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={editFtp}
                      onChangeText={setEditFtp}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>PESO (KG)</Text>
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={editPeso}
                      onChangeText={setEditPeso}
                    />
                  </View>
                </View>

                <Text style={styles.inputLabel}>INTERVALS.ICU ATHLETE ID (OPCIONAL)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Ej: i717135"
                  placeholderTextColor="#64748b"
                  autoCapitalize="none"
                  value={editAthId}
                  onChangeText={setEditAthId}
                />

                <Text style={styles.inputLabel}>INTERVALS.ICU API KEY (OPCIONAL)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="En Intervals.icu > Ajustes > Developer Settings"
                  placeholderTextColor="#64748b"
                  autoCapitalize="none"
                  secureTextEntry
                  value={editApiKey}
                  onChangeText={setEditApiKey}
                />

                <TouchableOpacity style={styles.primaryBtn} onPress={ejecutarLoginORegistro} disabled={cargando}>
                  {cargando ? (
                    <ActivityIndicator color="#020617" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Crear Cuenta y Entrar</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ==========================================================================
  // VISTA B: VENTANA DE PERFIL DEL CICLISTA LOGUEADO (PESTAÑA PERFIL)
  // ==========================================================================
  const wkg = (Number(editFtp || 250) / Math.max(40, Number(editPeso || 70))).toFixed(2);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={styles.profileScroll} showsVerticalScrollIndicator={false}>
        {/* CABECERA DEL CICLISTA ACTIVO */}
        <View style={styles.profileHeaderCard}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarInitials}>
              {(usuario.nombre || 'C').slice(0, 2).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>{usuario.nombre}</Text>
            <Text style={styles.profileEmail}>{usuario.email}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: usuario.intervals_conectado ? '#10b981' : '#f59e0b' },
                ]}
              />
              <Text style={styles.statusText}>
                {usuario.intervals_conectado
                  ? `Intervals.icu vinculado (${usuario.intervals_athlete_id})`
                  : 'Modo Local (Sin vincular a Intervals.icu)'}
              </Text>
            </View>
          </View>
        </View>

        {/* TARJETA 1: CONEXIÓN CON INTERVALS.ICU */}
        <View style={styles.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.cardTitle}>☁️ Conexión Intervals.icu</Text>
            <TouchableOpacity style={styles.syncSmallBtn} onPress={sincronizarAhora} disabled={sincronizando}>
              <Text style={styles.syncSmallBtnText}>
                {sincronizando ? 'Sincronizando...' : '🔄 Sincronizar Ahora'}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.cardDesc}>
            Vincula tu cuenta en un clic con OAuth2 o crea una cuenta nueva en Intervals.icu si aún no tienes una.
          </Text>

          <TouchableOpacity style={styles.intervalsPrimaryBtn} onPress={iniciarOAuthConIntervals}>
            <Ionicons name="flash" size={18} color="#020617" />
            <Text style={styles.intervalsPrimaryBtnText}>
              {usuario.intervals_conectado ? 'Re-vincular con Intervals.icu (OAuth2)' : 'Conectar con Intervals.icu (OAuth2)'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.intervalsSignupBtn}
            onPress={() => Linking.openURL('https://intervals.icu/')}
          >
            <Ionicons name="open-outline" size={15} color="#38bdf8" />
            <Text style={styles.intervalsSignupBtnText}>
              ¿No tienes cuenta en Intervals.icu? Créala gratis aquí
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{ marginTop: 12, alignItems: 'center' }}
            onPress={() => setMostrarClavesManuales((v) => !v)}
          >
            <Text style={{ color: '#94a3b8', fontSize: 11.5, fontWeight: '700' }}>
              {mostrarClavesManuales ? 'Ocultar configuración manual de API Key ▴' : 'Configurar Athlete ID / API Key manualmente ▾'}
            </Text>
          </TouchableOpacity>

          {mostrarClavesManuales && (
            <View style={{ marginTop: 10 }}>
              <Text style={styles.inputLabel}>ATHLETE ID (EJ: i717135)</Text>
              <TextInput
                style={styles.input}
                placeholder="i717135"
                placeholderTextColor="#64748b"
                autoCapitalize="none"
                value={editAthId}
                onChangeText={setEditAthId}
              />
              <Text style={styles.inputLabel}>API KEY DE INTERVALS.ICU</Text>
              <TextInput
                style={styles.input}
                placeholder="Dejar en blanco para mantener la actual"
                placeholderTextColor="#64748b"
                autoCapitalize="none"
                secureTextEntry
                value={editApiKey}
                onChangeText={setEditApiKey}
              />
            </View>
          )}
        </View>

        {/* TARJETA 2: PARÁMETROS FISIOLÓGICOS DEL CICLISTA */}
        <View style={styles.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.cardTitle}>⚡ Parámetros Fisiológicos</Text>
            <View style={styles.wkgPill}>
              <Text style={styles.wkgPillText}>{wkg} W/kg</Text>
            </View>
          </View>
          <Text style={styles.cardDesc}>
            Estos valores se actualizan automáticamente desde Intervals.icu, pero puedes ajustarlos manualmente cuando hagas un test de campo.
          </Text>

          <Text style={styles.inputLabel}>NOMBRE DEL CICLISTA</Text>
          <TextInput style={styles.input} value={editNombre} onChangeText={setEditNombre} />

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>FTP ACTUAL (W)</Text>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={editFtp}
                onChangeText={setEditFtp}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>PESO ACTUAL (KG)</Text>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={editPeso}
                onChangeText={setEditPeso}
              />
            </View>
          </View>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>PULSO UMBRAL LTHR (BPM)</Text>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={editLthr}
                onChangeText={setEditLthr}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>FC MÁXIMA (BPM)</Text>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={editMaxHr}
                onChangeText={setEditMaxHr}
              />
            </View>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={guardarCambiosPerfil} disabled={cargando}>
            {cargando ? (
              <ActivityIndicator color="#020617" />
            ) : (
              <Text style={styles.primaryBtnText}>Guardar Parámetros Fisiológicos</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* TARJETA 3: CAMBIAR DE USUARIO / CERRAR SESIÓN */}
        <TouchableOpacity
          style={styles.logoutCardBtn}
          onPress={() =>
            Alert.alert('Cerrar Sesión', '¿Quieres salir de esta cuenta o cambiar de ciclista?', [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Cerrar Sesión', style: 'destructive', onPress: () => cerrarSesionLocal() },
            ])
          }
        >
          <Ionicons name="log-out-outline" size={18} color="#f43f5e" />
          <Text style={styles.logoutCardBtnText}>Cerrar Sesión / Cambiar de Ciclista</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#020617' },
  authScroll: { flexGrow: 1, justifyContent: 'center', padding: 18, paddingBottom: 60 },
  profileScroll: { padding: 16, paddingBottom: 120 },

  heroHeader: { alignItems: 'center', marginBottom: 18 },
  logoBadge: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  authBrand: { color: '#ffffff', fontSize: 24, fontWeight: '900' },
  authSubtitle: { color: '#94a3b8', fontSize: 12.5, textAlign: 'center', marginTop: 4, lineHeight: 18 },

  segmentedBar: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 14,
  },
  segmentItem: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  segmentItemActive: { backgroundColor: '#10b981' },
  segmentText: { color: '#94a3b8', fontSize: 11.5, fontWeight: '800' },
  segmentTextActive: { color: '#020617', fontWeight: '900' },

  card: {
    backgroundColor: '#0f172a',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 14,
  },
  cardTitle: { color: '#ffffff', fontSize: 16, fontWeight: '900' },
  cardDesc: { color: '#94a3b8', fontSize: 12, marginTop: 4, marginBottom: 14, lineHeight: 17 },

  intervalsPrimaryBtn: {
    backgroundColor: '#38bdf8',
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  intervalsPrimaryBtnText: { color: '#020617', fontSize: 14, fontWeight: '900' },

  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 14 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#1e293b' },
  dividerText: { color: '#64748b', fontSize: 10, fontWeight: '800', fontFamily: MONO_FONT },

  intervalsSignupBtn: {
    marginTop: 8,
    backgroundColor: '#020617',
    borderColor: '#334155',
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  intervalsSignupBtnText: { color: '#38bdf8', fontSize: 11.5, fontWeight: '800' },

  oauthWaitingBox: {
    backgroundColor: '#020617',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  oauthWaitingTitle: { color: '#ffffff', fontSize: 13.5, fontWeight: '800', marginTop: 10, textAlign: 'center' },
  oauthWaitingSub: { color: '#94a3b8', fontSize: 11.5, marginTop: 4, textAlign: 'center', lineHeight: 16 },
  cancelOAuthBtn: { marginTop: 12, paddingVertical: 6, paddingHorizontal: 14 },
  cancelOAuthText: { color: '#f43f5e', fontWeight: '800', fontSize: 12 },

  inputLabel: { color: '#94a3b8', fontSize: 10, fontWeight: '800', marginBottom: 5, marginTop: 10, fontFamily: MONO_FONT },
  input: {
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#ffffff',
    fontSize: 13.5,
  },
  primaryBtn: {
    backgroundColor: '#10b981',
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 16,
  },
  primaryBtnText: { color: '#020617', fontSize: 13.5, fontWeight: '900' },

  profileHeaderCard: {
    backgroundColor: '#0f172a',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.4)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 14,
  },
  avatarCircle: {
    width: 54,
    height: 54,
    borderRadius: 16,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: { color: '#020617', fontSize: 20, fontWeight: '900', fontFamily: MONO_FONT },
  profileName: { color: '#ffffff', fontSize: 18, fontWeight: '900' },
  profileEmail: { color: '#94a3b8', fontSize: 12, marginTop: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: '#cbd5e1', fontSize: 11, fontWeight: '700', fontFamily: MONO_FONT },

  syncSmallBtn: {
    backgroundColor: 'rgba(56,189,248,0.15)',
    borderColor: '#38bdf8',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  syncSmallBtnText: { color: '#38bdf8', fontSize: 10.5, fontWeight: '800' },

  wkgPill: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderColor: '#10b981',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  wkgPillText: { color: '#34d399', fontSize: 12, fontWeight: '900', fontFamily: MONO_FONT },

  logoutCardBtn: {
    backgroundColor: 'rgba(244,63,94,0.08)',
    borderColor: '#f43f5e',
    borderWidth: 1,
    paddingVertical: 14,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  logoutCardBtnText: { color: '#f43f5e', fontSize: 13.5, fontWeight: '900' },
});