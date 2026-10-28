import React, { useEffect, useState } from 'react';
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

  // Estado formulario Login / Registro
  const [modoRegistro, setModoRegistro] = useState(false);
  const [cargandoAuth, setCargandoAuth] = useState(false);
  const [email, setEmail] = useState('diego@allue.com');
  const [password, setPassword] = useState('');
  const [nombre, setNombre] = useState('');
  const [ftp, setFtp] = useState('280');
  const [peso, setPeso] = useState('70');
  const [athleteId, setAthleteId] = useState('');
  const [apiKey, setApiKey] = useState('');

  // Modal de edición de perfil una vez logueado
  const [perfilModal, setPerfilModal] = useState(false);
  const [editNombre, setEditNombre] = useState('');
  const [editFtp, setEditFtp] = useState('');
  const [editPeso, setEditPeso] = useState('');
  const [editLthr, setEditLthr] = useState('');
  const [editMaxHr, setEditMaxHr] = useState('');
  const [editAthId, setEditAthId] = useState('');
  const [editApiKey, setEditApiKey] = useState('');

  useEffect(() => {
    const desuscribir = suscribirAuth(() => {
      setUsuario(getAuthUser());
    });
    restaurarSesionLocal().finally(() => setInicializando(false));
    return desuscribir;
  }, []);

  const abrirModalPerfil = () => {
    if (!usuario) return;
    setEditNombre(usuario.nombre);
    setEditFtp(String(usuario.ftp_actual || 250));
    setEditPeso(String(usuario.peso_actual || 70));
    setEditLthr(String(usuario.lthr || 175));
    setEditMaxHr(String(usuario.max_hr || 195));
    setEditAthId(usuario.intervals_athlete_id || '');
    setEditApiKey('');
    setPerfilModal(true);
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
            ftp_actual: Number(ftp) || 250,
            peso_actual: Number(peso) || 70.0,
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
      Alert.alert('Error de conexión', 'No se pudo conectar con el servidor en Render.');
    } finally {
      setCargandoAuth(false);
    }
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
          lthr: Number(editLthr) || 175,
          max_hr: Number(editMaxHr) || 195,
          intervals_athlete_id: editAthId,
          intervals_api_key: editApiKey || null,
        }),
      });
      const data = await res.json();
      if (res.ok && data.usuario) {
        setUsuario(data.usuario);
        setPerfilModal(false);
        Alert.alert('Perfil Actualizado ✅', 'Tus métricas y conexión con Intervals.icu se han actualizado.');
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

  // ==================== PANTALLA DE LOGIN / REGISTRO ====================
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
              Plataforma de entrenamiento inteligente adaptada a tu fisiología y a Intervals.icu
            </Text>

            <View style={styles.modeSwitchRow}>
              <TouchableOpacity
                style={[styles.modeBtn, !modoRegistro && styles.modeBtnActive]}
                onPress={() => setModoRegistro(false)}
              >
                <Text style={[styles.modeBtnText, !modoRegistro && styles.modeBtnTextActive]}>
                  Iniciar Sesión
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeBtn, modoRegistro && styles.modeBtnActive]}
                onPress={() => setModoRegistro(true)}
              >
                <Text style={[styles.modeBtnText, modoRegistro && styles.modeBtnTextActive]}>
                  Crear Cuenta
                </Text>
              </TouchableOpacity>
            </View>

            {modoRegistro && (
              <>
                <Text style={styles.inputLabel}>NOMBRE DEL CICLISTA</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Ej: Carlos Sastre"
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

            {modoRegistro && (
              <>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>FTP ACTUAL (W)</Text>
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={ftp}
                      onChangeText={setFtp}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>PESO (KG)</Text>
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={peso}
                      onChangeText={setPeso}
                    />
                  </View>
                </View>

                <Text style={styles.inputLabel}>INTERVALS.ICU ATHLETE ID (OPCIONAL)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Ej: i717135"
                  placeholderTextColor="#64748b"
                  autoCapitalize="none"
                  value={athleteId}
                  onChangeText={setAthleteId}
                />

                <Text style={styles.inputLabel}>INTERVALS.ICU API KEY (OPCIONAL)</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Tu clave API de Intervals.icu"
                  placeholderTextColor="#64748b"
                  autoCapitalize="none"
                  secureTextEntry
                  value={apiKey}
                  onChangeText={setApiKey}
                />
              </>
            )}

            <TouchableOpacity
              style={styles.submitBtn}
              onPress={ejecutarLoginORegistro}
              disabled={cargandoAuth}
            >
              {cargandoAuth ? (
                <ActivityIndicator color="#020617" />
              ) : (
                <Text style={styles.submitBtnText}>
                  {modoRegistro ? 'Crear Cuenta y Entrar' : 'Entrar a mi Panel'}
                </Text>
              )}
            </TouchableOpacity>

            {!modoRegistro && (
              <Text style={styles.demoHint}>
                💡 Tu cuenta principal es diego@allue.com (contraseña inicial: 123456)
              </Text>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ==================== APLICACIÓN AUTENTICADA ====================
  return (
    <View style={{ flex: 1, backgroundColor: '#020617' }}>
      {/* Barra superior compacta con el usuario activo */}
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

      {/* MODAL DE PERFIL Y CONEXIÓN INTERVALS.ICU */}
      <Modal visible={perfilModal} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>👤 Perfil del Ciclista ({usuario.email})</Text>
              <TouchableOpacity onPress={() => setPerfilModal(false)}>
                <Text style={{ color: '#94a3b8', fontSize: 18, fontWeight: '800' }}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={{ marginTop: 10 }}>
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

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>LTHR (BPM)</Text>
                  <TextInput style={styles.input} keyboardType="numeric" value={editLthr} onChangeText={setEditLthr} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inputLabel}>FC MÁX (BPM)</Text>
                  <TextInput style={styles.input} keyboardType="numeric" value={editMaxHr} onChangeText={setEditMaxHr} />
                </View>
              </View>

              <Text style={styles.inputLabel}>INTERVALS.ICU ATHLETE ID</Text>
              <TextInput
                style={styles.input}
                placeholder="Ej: i717135"
                placeholderTextColor="#64748b"
                autoCapitalize="none"
                value={editAthId}
                onChangeText={setEditAthId}
              />

              <Text style={styles.inputLabel}>NUEVA API KEY DE INTERVALS.ICU (DEJAR EN BLANCO PARA CONSERVAR)</Text>
              <TextInput
                style={styles.input}
                placeholder="••••••••••••"
                placeholderTextColor="#64748b"
                autoCapitalize="none"
                secureTextEntry
                value={editApiKey}
                onChangeText={setEditApiKey}
              />

              <TouchableOpacity style={styles.submitBtn} onPress={guardarCambiosPerfil}>
                <Text style={styles.submitBtnText}>Guardar Perfil y Sincronizar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.logoutBtn}
                onPress={() => {
                  setPerfilModal(false);
                  cerrarSesionLocal();
                }}
              >
                <Text style={styles.logoutBtnText}>Cerrar Sesión / Cambiar de Usuario</Text>
              </TouchableOpacity>
            </ScrollView>
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
  authSubtitle: { color: '#94a3b8', fontSize: 12.5, textAlign: 'center', marginTop: 6, marginBottom: 18 },
  modeSwitchRow: {
    flexDirection: 'row',
    backgroundColor: '#020617',
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  modeBtn: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  modeBtnActive: { backgroundColor: '#10b981' },
  modeBtnText: { color: '#94a3b8', fontWeight: '800', fontSize: 12.5 },
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
    marginTop: 20,
  },
  submitBtnText: { color: '#020617', fontSize: 14, fontWeight: '900' },
  demoHint: { color: '#64748b', fontSize: 11, textAlign: 'center', marginTop: 14 },

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
    maxHeight: '88%',
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
    marginBottom: 20,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#f43f5e',
    alignItems: 'center',
  },
  logoutBtnText: { color: '#f43f5e', fontSize: 13, fontWeight: '800' },
});