import { Tabs, DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AnimatedSplashOverlay } from '@/components/animated-icon';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />

      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: '#10b981',
          tabBarInactiveTintColor: '#64748b',
          tabBarStyle: {
            backgroundColor: '#020617',
            borderTopColor: '#1e293b',
            borderTopWidth: 1,
            height: 62,
            minHeight: Platform.OS === 'ios' ? 85 : 75,
            paddingBottom: Platform.OS === 'ios' ? 25 : 20,
            paddingTop: 2,
            elevation: 10,
            shadowColor: '#000',
            shadowOpacity: 0.05,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: -4 },
          },
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '700',
          },
        }}
      >

        <Tabs.Screen
          name="index"
          options={{
            title: 'Coach',
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "chatbubbles" : "chatbubbles-outline"} size={26} color={color} />
            )
          }}
        />

        <Tabs.Screen
          name="calendario"
          options={{
            title: 'Agenda',
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "calendar" : "calendar-outline"} size={26} color={color} />
            )
          }}
        />

        <Tabs.Screen
          name="rendimiento"
          options={{
            title: 'Rendimiento',
            tabBarIcon: ({ color, focused }) => (
              <Ionicons name={focused ? "stats-chart" : "stats-chart-outline"} size={26} color={color} />
            )
          }}
        />

      </Tabs>
    </ThemeProvider>
  );
}