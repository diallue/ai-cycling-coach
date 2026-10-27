import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';

export default function AppLayout() {
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
  );
}