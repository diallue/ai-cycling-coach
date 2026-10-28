import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  UsuarioAuth,
  getAuthUser,
  restaurarSesionLocal,
  suscribirAuth,
  instalarInterceptorFetch,
} from '../constants/auth';
import PerfilScreen from './perfil';

instalarInterceptorFetch();

export default function AppLayout() {
  const [inicializando, setInicializando] = useState(true);
  const [usuario, setUsuario] = useState<UsuarioAuth | null>(getAuthUser());

  useEffect(() => {
    const desuscribir = suscribirAuth(() => {
      setUsuario(getAuthUser());
    });
    restaurarSesionLocal().finally(() => setInicializando(false));
    return desuscribir;
  }, []);

  if (inicializando) {
    return (
      <View style={{ flex: 1, backgroundColor: '#020617', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  // Si aún no ha iniciado sesión, mostramos directamente la ventana de Perfil / Acceso a pantalla completa
  if (!usuario) {
    return <PerfilScreen />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#090d16',
          borderTopColor: '#1e293b',
          borderTopWidth: 1,
          height: Platform.OS === 'ios' ? 86 : 86,
          paddingBottom: Platform.OS === 'ios' ? 26 : 10,
          paddingTop: 8,
        },
        tabBarActiveTintColor: '#10b981',
        tabBarInactiveTintColor: '#64748b',
        tabBarLabelStyle: {
          fontSize: 10.5,
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
      <Tabs.Screen
        name="perfil"
        options={{
          title: 'Perfil',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle" size={size} color={color as string} />
          ),
        }}
      />
    </Tabs>
  );
}