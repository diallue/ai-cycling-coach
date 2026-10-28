import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  ScrollView,
  Alert,
  Platform,
  KeyboardAvoidingView,
  Linking,
} from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  API_BASE_URL,
  UsuarioAuth,
  getAuthUser,
  guardarSesionLocal,
  cerrarSesionLocal,
  restaurarSesionLocal,
  suscribirAuth,
  instalarInterceptorFetch,
} from '../constants/auth';

instalarInterceptorFetch();

export default function AppLayout() {
  const [inicializando, setInicializando] = useState(true);
  const [usuario, setUsuario] = useState<UsuarioAuth | null>(getAuthUser());

  // Estado OAuth2 Intervals.icu
  const [esperandoOAuth, setEsperandoOAuth] = useState(false);
  const pollTimerRef = useRef<any>(null);

  // Acceso directo / manual de respaldo
  const [mostrarManual, setMostrarManual] = useState(false);
  const [modoRegistro, setModoRegistro] = useState(false);
  const [cargandoAuth, setCargandoAuth] = useState(false);
  const [email, setEmail] = useState('diego@allue.com');
  const [password, setPassword] = useState('');
  const [nombre, setNombre] = useState('');
  const [athleteId, setAthleteId] = useState('');
  const [apiKey, setApiKey] = useState('');

  // Modal de edición de perfil una vez logueado
  const [perfilModal, setPerfilModal] = useState(false);
  const [editNombre, setEditNombre] = useState('');
  const [editFtp, setEditFtp] = useState('');
  const [editPeso, setEditPeso] = useState('');

  useEffect(() => {
    const desuscribir = suscribirAuth(() => {
      setUsuario(getAuthUser());
    });
    restaurarSesionLocal().finally(() => setInicializando(false));
    return () => {
      desuscribir();
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const iniciarOAuthConIntervals = async () => {
    try {
      setCargandoAuth(true);
      const res = await fetch(`${API_BASE_URL}/api/auth/intervals/login-url`);
      const data = await res.json();

      if (!data.oauth_configurado) {
        Alert.alert(
          'OAuth pendiente de Client ID',
          'Añade INTERVALS_CLIENT_ID e INTERVALS_CLIENT_SECRET en el apartado Environment de Render, o entra con el acceso directo de abajo.',
          [
            { text: 'Abrir Intervals.icu', onPress: () => Linking.openURL('https://intervals.icu/oauth/apply') },
            { text: 'Usar acceso con email', onPress: () => setMostrarManual(true) },
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
      Alert.alert('Error', 'No se pudo conectar con el servidor.');
    } finally {
      setCargandoAuth(false);
    }
  };

  const ejecutarLoginORegistro = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Campos requeridos', 'Introduce tu email y contraseña.');
      return;
    }
    setCargandoAuth(true);
    try {
      const endpoint = modoRegistro ? '/api/auth/register' : '/api/auth/login';
      const body = modoRegistro
        ? {
            nombre: nombre.trim() || 'Ciclista',
            email: email.trim(),
            password: password.trim(),
            intervals_athlete_id: athleteId.trim() || null,
            intervals_api_key: apiKey.trim() || null,
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
      Alert.alert('Error de conexión', 'No se pudo conectar con el servidor.');
    } finally {
      setCargandoAuth(false);
    }
  };

  const abrirModalPerfil = () => {
    if (!usuario) return;
    setEditNombre(usuario.nombre);
    setEditFtp(String(usuario.ftp_actual || 250));
    setEditPeso(String(usuario.peso_actual || 70));
    setPerfilModal(true);
  };

  const guardarCambiosPerfil = async () => {
    try {
      setCargandoAuth(true);
      const res = await fetch(`${API_BASE_URL}/api/auth/perfil`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: editNombre,
          ftp_actual: Number(editFtp) || 250,
          peso_actual: Number(editPeso) || 70,
        }),
      });
      const data = await res.json();
      if (res.ok && data.usuario) {
        setUsuario(data.usuario);
        setPerfilModal(false);
      }
    } catch {
      Alert.alert('Error', 'No se pudo actualizar el perfil.');
    } finally {
      setCargandoAuth(false);
    }
  };

  if (inicializando) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  // ==================== PANTALLA DE ACCESO CON INTERVALS.ICU ====================
  if (!usuario) {
    return (
      <KeyboardAvoidingView
        style={styles.authContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.authScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.authCard}>
            <View style={styles.logoBadge}>
              <Text style={{ fontSize: 28 }}>🚴‍♂️</Text>
            </View>
            <Text style={styles.authBrand}>
              VELO<Text style={{ color: '#10b981' }}>COACH</Text> IA
            </Text>
            <Text style={styles.authSubtitle}>
              Conecta tu cuenta de Intervals.icu en un clic. Importaremos tu FTP, peso, historial y enviaremos tus sesiones al Garmin/Wahoo automáticamente.
            </Text>

            {esperandoOAuth ? (
              <View style={styles.oauthWaitingBox}>
                <ActivityIndicator size="large" color="#38bdf8" />
                <Text style={styles.oauthWaitingTitle}>Esperando autorización de Intervals.icu...</Text>
                <Text style={styles.oauthWaitingSub}>
                  Inicia sesión en la ventana del navegador y pulsa "Confirmar". Entrarás automáticamente al terminar.
                </Text>
                <TouchableOpacity
                  style={styles.cancelOAuthBtn}
                  onPress={() => {
                    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
                    setEsperandoOAuth(false);
                  }}
                >
                  <Text style={styles.cancelOAuthText}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <TouchableOpacity
                  style={styles.intervalsPrimaryBtn}
                  onPress={iniciarOAuthConIntervals}
                  disabled={cargandoAuth}
                >
                  <Ionicons name="flash" size={18} color="#020617" />
                  <Text style={styles.intervalsPrimaryBtnText}>
                    Iniciar sesión con Intervals.icu
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.intervalsSignupBtn}
                  onPress={() => Linking.openURL('https://intervals.icu/')}
                >
                  <Text style={styles.intervalsSignupBtnText}>
                    🌐 ¿No tienes cuenta en Intervals.icu? Créala gratis aquí
                  </Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              style={{ marginTop: 22, alignItems: 'center' }}
              onPress={() => setMostrarManual((v) => !v)}
            >
              <Text style={{ color: '#64748b', fontSize: 12, fontWeight: '700' }}>
                {mostrarManual ? 'Ocultar acceso con email ▴' : 'Entrar con email y contraseña ▾'}
              </Text>
            </TouchableOpacity>

            {mostrarManual && (
              <View style={{ marginTop: 12, borderTopWidth: 1, borderColor: '#1e293b', paddingTop: 12 }}>
                <View style={styles.modeSwitchRow}>
                  <TouchableOpacity
                    style={[styles.modeBtn, !modoRegistro && styles.modeBtnActive]}
                    onPress={() => setModoRegistro(false)}
                  >
                    <Text style={[styles.modeBtnText, !modoRegistro && styles.modeBtnTextActive]}>
                      Entrar
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modeBtn, modoRegistro && styles.modeBtnActive]}
                    onPress={() => setModoRegistro(true)}
                  >
                    <Text style={[styles.modeBtnText, modoRegistro && styles.modeBtnTextActive]}>
                      Vincular Manual
                    </Text>
                  </TouchableOpacity>
                </View>

                {modoRegistro && (
                  <>
                    <Text style={styles.inputLabel}>NOMBRE</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Tu nombre"
                      placeholderTextColor="#64748b"
                      value={nombre}
                      onChangeText={setNombre}
                    />
                  </>
                )}

                <Text style={styles.inputLabel}>EMAIL</Text>
                <TextInput
                  style={styles.input}
                  placeholder="tu@email.com"
                  placeholderTextColor="#64748b"
                  autoCapitalize="none"
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

                {modoRegistro && (
                  <>
                    <Text style={styles.inputLabel}>ATHLETE ID DE INTERVALS.ICU (EJ: i717135)</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="i717135"
                      placeholderTextColor="#64748b"
                      autoCapitalize="none"
                      value={athleteId}
                      onChangeText={setAthleteId}
                    />
                    <Text style={styles.inputLabel}>API KEY DE INTERVALS.ICU</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Tu API Key en Settings > Developer"
                      placeholderTextColor="#64748b"
                      autoCapitalize="none"
                      secureTextEntry
                      value={apiKey}
                      onChangeText={setApiKey}
                    />
                  </>
                )}

                <TouchableOpacity style={styles.submitBtn} onPress={ejecutarLoginORegistro}>
                  <Text style={styles.submitBtnText}>
                    {modoRegistro ? 'Guardar y Entrar' : 'Entrar a mi Panel'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ==================== APLICACIÓN AUTENTICADA ====================
  return (
    <View style={{ flex: 1, backgroundColor: '#020617' }}>
      <View style={styles.userTopBar}>
        <TouchableOpacity style={styles.userPill} onPress={abrirModalPerfil}>
          <Ionicons name="person-circle" size={16} color="#10b981" />
          <Text style={styles.userPillText}>
            {usuario.nombre} • {usuario.ftp_actual}W {usuario.intervals_conectado ? '• ☁️ ICU' : ''}
          </Text>
          <Ionicons name="settings-outline" size={13} color="#94a3b8" />
        </TouchableOpacity>
      </View>

      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: '#090d16',
            borderTopColor: '#1e293b',
            borderTopWidth: 1,
            height: Platform.OS === 'ios' ? 86 : 66,
            paddingBottom: Platform.OS === 'ios' ? 26 : 10,
            paddingTop: 8,
          },
          tabBarActiveTintColor: '#10b981',
          tabBarInactiveTintColor: '#64748b',
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '800',
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Coach',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="chatbubble-ellipses" size={size} color={color as string} />
            ),
          }}
        />
        <Tabs.Screen
          name="calendario"
          options={{
            title: 'Agenda',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="calendar" size={size} color={color as string} />
            ),
          }}
        />
        <Tabs.Screen
          name="temporada"
          options={{
            title: 'Temporada',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="flag" size={size} color={color as string} />
            ),
          }}
        />
        <Tabs.Screen
          name="rendimiento"
          options={{
            title: 'Lab',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="stats-chart" size={size} color={color as string} />
            ),
          }}
        />
      </Tabs>

      <Modal visible={perfilModal} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>👤 {usuario.nombre}</Text>
              <TouchableOpacity onPress={() => setPerfilModal(false)}>
                <Text style={{ color: '#94a3b8', fontSize: 18, fontWeight: '800' }}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>NOMBRE</Text>
            <TextInput style={styles.input} value={editNombre} onChangeText={setEditNombre} />

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.inputLabel}>FTP (W)</Text>
                <TextInput style={styles.input} keyboardType="numeric" value={editFtp} onChangeText={setEditFtp} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.inputLabel}>PESO (KG)</Text>
                <TextInput style={styles.input} keyboardType="numeric" value={editPeso} onChangeText={setEditPeso} />
              </View>
            </View>

            <TouchableOpacity style={styles.submitBtn} onPress={guardarCambiosPerfil}>
              <Text style={styles.submitBtnText}>Guardar Cambios</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.logoutBtn}
              onPress={() => {
                setPerfilModal(false);
                cerrarSesionLocal();
              }}
            >
              <Text style={styles.logoutBtnText}>Cerrar Sesión / Cambiar Cuenta de Intervals.icu</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingScreen: { flex: 1, backgroundColor: '#020617', justifyContent: 'center', alignItems: 'center' },
  authContainer: { flex: 1, backgroundColor: '#020617' },
  authScroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  authCard: {
    backgroundColor: '#0f172a',
    borderRadius: 24,
    padding: 22,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  logoBadge: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 12,
  },
  authBrand: { color: '#ffffff', fontSize: 24, fontWeight: '900', textAlign: 'center' },
  authSubtitle: { color: '#94a3b8', fontSize: 12.5, textAlign: 'center', marginTop: 6, marginBottom: 20, lineHeight: 18 },

  intervalsPrimaryBtn: {
    backgroundColor: '#38bdf8',
    paddingVertical: 15,
    paddingHorizontal: 16,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  intervalsPrimaryBtnText: { color: '#020617', fontSize: 15, fontWeight: '900' },

  intervalsSignupBtn: {
    marginTop: 10,
    backgroundColor: '#020617',
    borderColor: '#334155',
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  intervalsSignupBtnText: { color: '#38bdf8', fontSize: 12, fontWeight: '800' },

  oauthWaitingBox: {
    backgroundColor: '#020617',
    borderRadius: 16,
    padding: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  oauthWaitingTitle: { color: '#ffffff', fontSize: 14, fontWeight: '800', marginTop: 12, textAlign: 'center' },
  oauthWaitingSub: { color: '#94a3b8', fontSize: 12, marginTop: 6, textAlign: 'center', lineHeight: 17 },
  cancelOAuthBtn: { marginTop: 14, paddingVertical: 8, paddingHorizontal: 16 },
  cancelOAuthText: { color: '#f43f5e', fontWeight: '800', fontSize: 12 },

  modeSwitchRow: {
    flexDirection: 'row',
    backgroundColor: '#020617',
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  modeBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  modeBtnActive: { backgroundColor: '#10b981' },
  modeBtnText: { color: '#94a3b8', fontWeight: '800', fontSize: 12 },
  modeBtnTextActive: { color: '#020617', fontWeight: '900' },
  inputLabel: { color: '#94a3b8', fontSize: 10, fontWeight: '800', marginBottom: 5, marginTop: 10 },
  input: {
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: '#ffffff',
    fontSize: 13.5,
  },
  submitBtn: {
    backgroundColor: '#10b981',
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 18,
  },
  submitBtnText: { color: '#020617', fontSize: 14, fontWeight: '900' },

  userTopBar: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 44 : 10,
    right: 14,
    zIndex: 99,
  },
  userPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  userPillText: { color: '#e2e8f0', fontSize: 11, fontWeight: '800' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    borderTopWidth: 1,
    borderColor: '#1e293b',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderColor: '#1e293b',
  },
  modalTitle: { color: '#ffffff', fontSize: 16, fontWeight: '900' },
  logoutBtn: {
    marginTop: 12,
    marginBottom: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#f43f5e',
    alignItems: 'center',
  },
  logoutBtnText: { color: '#f43f5e', fontSize: 13, fontWeight: '800' },
});