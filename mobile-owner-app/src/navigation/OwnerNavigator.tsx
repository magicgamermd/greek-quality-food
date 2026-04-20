import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import { useAuth } from "../hooks/useAuth";
import { colors } from "../theme/colors";
import { LoginScreen } from "../screens/LoginScreen";
import { OwnerDashboardScreen } from "../screens/OwnerDashboardScreen";
import { IncomingAcceptanceScreen } from "../screens/IncomingAcceptanceScreen";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function OwnerTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 64,
          paddingTop: 6,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: {
          fontSize: 11,
          marginBottom: 4,
        },
      }}
    >
      <Tab.Screen
        name="Analytics"
        component={OwnerDashboardScreen}
        options={{
          tabBarLabel: "Анализи",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              color={color}
              size={20}
              name={focused ? "stats-chart" : "stats-chart-outline"}
            />
          ),
        }}
      />
      <Tab.Screen
        name="Incoming"
        component={IncomingAcceptanceScreen}
        options={{
          tabBarLabel: "Доставки",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              color={color}
              size={20}
              name={focused ? "cube" : "cube-outline"}
            />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

const theme = {
  dark: true,
  colors: {
    primary: colors.primary,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    notification: colors.warning,
  },
  fonts: {
    regular: { fontFamily: "System", fontWeight: "400" as const },
    medium: { fontFamily: "System", fontWeight: "500" as const },
    bold: { fontFamily: "System", fontWeight: "700" as const },
    heavy: { fontFamily: "System", fontWeight: "800" as const },
  },
};

export function OwnerNavigator() {
  const { user } = useAuth();

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {user ? (
          <Stack.Screen name="OwnerTabs" component={OwnerTabs} />
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
