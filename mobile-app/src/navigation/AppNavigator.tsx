import React from "react";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";

import { LoginScreen } from "../screens/LoginScreen";
import { DashboardScreen } from "../screens/DashboardScreen";
import { CameraInvoiceScreen } from "../screens/CameraInvoiceScreen";
import { SalesScreen } from "../screens/SalesScreen";
import { InventoryScreen } from "../screens/InventoryScreen";
import { IncomingGoodsScreen } from "../screens/IncomingGoodsScreen";
import { OrdersScreen } from "../screens/OrdersScreen";
import { ReportsScreen } from "../screens/ReportsScreen";
import { NotificationsScreen } from "../screens/NotificationsScreen";
import { MoreScreen } from "../screens/MoreScreen";
import { useAuth } from "../hooks/useAuth";
import { colors } from "../theme/colors";

// ─── Navigators ───────────────────────────────────────────────────────────────
const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function MainTabs() {
  const insets = useSafeAreaInsets();
  const tabBarHeight = 60 + insets.bottom;

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "transparent",
          borderTopWidth: 1,
          borderTopColor: "rgba(255,255,255,0.08)",
          height: tabBarHeight,
          paddingTop: 10,
          paddingBottom: insets.bottom > 0 ? insets.bottom : 8,
          position: "absolute",
          elevation: 0,
        },
        tabBarBackground: () => (
          <BlurView
            intensity={40}
            tint="dark"
            style={StyleSheet.absoluteFill}
          />
        ),
        tabBarActiveTintColor: colors.tabActive,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: "500",
        },
      }}
    >
      <Tab.Screen
        name="Dashboard"
        component={DashboardScreen}
        options={{
          tabBarLabel: "Панел",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons
              name={focused ? "grid" : "grid-outline"}
              size={22}
              color={color}
            />
          ),
        }}
      />
      <Tab.Screen
        name="CameraTab"
        component={CameraInvoiceScreen}
        options={{
          tabBarLabel: "Сканирай",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons
              name={focused ? "camera" : "camera-outline"}
              size={22}
              color={color}
            />
          ),
        }}
      />
      <Tab.Screen
        name="Sales"
        component={SalesScreen}
        options={{
          tabBarLabel: "Продажби",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons
              name={focused ? "trending-up" : "trending-up-outline"}
              size={22}
              color={color}
            />
          ),
        }}
      />
      <Tab.Screen
        name="More"
        component={MoreScreen}
        options={{
          tabBarLabel: "Още",
          tabBarIcon: ({ focused, color }) => (
            <Ionicons
              name={
                focused ? "ellipsis-horizontal" : "ellipsis-horizontal-outline"
              }
              size={22}
              color={color}
            />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

const DARK_THEME = {
  dark: true,
  colors: {
    primary: colors.accent,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    notification: colors.danger,
  },
  fonts: {
    regular: { fontFamily: "System", fontWeight: "400" as const },
    medium: { fontFamily: "System", fontWeight: "500" as const },
    bold: { fontFamily: "System", fontWeight: "700" as const },
    heavy: { fontFamily: "System", fontWeight: "900" as const },
  },
};

export function AppNavigator() {
  const { user } = useAuth();

  return (
    <NavigationContainer theme={DARK_THEME}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {user ? (
          <>
            <Stack.Screen name="Main" component={MainTabs} />
            <Stack.Screen
              name="CameraInvoice"
              component={CameraInvoiceScreen}
            />
            <Stack.Screen name="Inventory" component={InventoryScreen} />
            <Stack.Screen name="Orders" component={OrdersScreen} />
            <Stack.Screen
              name="IncomingGoods"
              component={IncomingGoodsScreen}
            />
            <Stack.Screen name="Reports" component={ReportsScreen} />
            <Stack.Screen
              name="Notifications"
              component={NotificationsScreen}
            />
          </>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
