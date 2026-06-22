import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import React from "react";
import { Text, View } from "react-native";

import { useSync } from "@/context/SyncContext";
import { useColors } from "@/hooks/useColors";

function PendingBadge() {
  const { pendingCount } = useSync();
  const colors = useColors();

  if (pendingCount === 0) {
    return null;
  }

  return (
    <View
      style={{
        position: "absolute",
        top: -5,
        right: -10,
        minWidth: 17,
        height: 17,
        paddingHorizontal: 3,
        borderRadius: 9,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.pending,
      }}
    >
      <Text
        style={{
          color: "#ffffff",
          fontSize: 10,
          fontWeight: "700",
        }}
      >
        {pendingCount > 99 ? "99+" : pendingCount}
      </Text>
    </View>
  );
}

export default function TabLayout() {
  const colors = useColors();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Scan",
          tabBarIcon: ({ color, size }) => (
            <Feather name="maximize" color={color} size={size} />
          ),
        }}
      />

      <Tabs.Screen
        name="history"
        options={{
          title: "Queue",
          tabBarIcon: ({ color, size }) => (
            <View>
              <Feather name="list" color={color} size={size} />
              <PendingBadge />
            </View>
          ),
        }}
      />

      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Feather name="settings" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
