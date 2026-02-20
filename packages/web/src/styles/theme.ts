// =============================================================================
// Chakra UI Theme Configuration
// Custom theme with 5 responsive breakpoints for mobile-first design
// Breakpoints: Mobile S (320px), Mobile L (480px), Tablet (768px),
//              Laptop (1024px), Desktop (1440px)
// =============================================================================

import { extendTheme, type ThemeConfig } from '@chakra-ui/react';

// Color mode config: default to dark (like Zoom/Meet)
const config: ThemeConfig = {
  initialColorMode: 'dark',
  useSystemColorMode: false,
};

// 5 responsive breakpoints covering all target devices
// Chakra uses mobile-first (min-width) media queries
const breakpoints = {
  base: '0px',    // Mobile S: 320px+ (smallest phones)
  sm: '480px',    // Mobile L: 480px+ (larger phones, landscape)
  md: '768px',    // Tablet: 768px+ (iPad portrait, small tablets)
  lg: '1024px',   // Laptop: 1024px+ (laptops, iPad landscape)
  xl: '1440px',   // Desktop: 1440px+ (external monitors, large screens)
};

const theme = extendTheme({
  config,
  breakpoints,

  // --- Global Styles ---
  styles: {
    global: {
      body: {
        bg: 'gray.900',
        color: 'white',
      },
    },
  },

  // --- Color Palette ---
  // Custom brand colors inspired by Zoom/Meet
  colors: {
    brand: {
      50: '#e3f2fd',
      100: '#bbdefb',
      200: '#90caf9',
      300: '#64b5f6',
      400: '#42a5f5',
      500: '#2196f3',  // Primary blue
      600: '#1e88e5',
      700: '#1976d2',
      800: '#1565c0',
      900: '#0d47a1',
    },
    meeting: {
      bg: '#1a1a2e',       // Dark background for meeting room
      surface: '#16213e',  // Card/panel background
      control: '#0f3460',  // Control bar background
      danger: '#e53e3e',   // End call / destructive actions
      success: '#38a169',  // Active mic/camera indicator
      warning: '#d69e2e',  // Lobby/waiting indicator
    },
  },

  // --- Component Defaults ---
  components: {
    Button: {
      defaultProps: {
        colorScheme: 'brand',
      },
      variants: {
        // Red button for destructive actions (leave meeting, kick)
        danger: {
          bg: 'meeting.danger',
          color: 'white',
          _hover: { bg: 'red.600' },
        },
        // Subtle button for meeting controls (mute, camera toggle)
        control: {
          bg: 'whiteAlpha.200',
          color: 'white',
          borderRadius: 'full',
          _hover: { bg: 'whiteAlpha.300' },
        },
        // Active state for toggled controls (mic on, camera on)
        controlActive: {
          bg: 'meeting.success',
          color: 'white',
          borderRadius: 'full',
          _hover: { bg: 'green.600' },
        },
      },
    },
    Card: {
      baseStyle: {
        container: {
          bg: 'meeting.surface',
          borderColor: 'whiteAlpha.200',
        },
      },
    },
  },
});

export default theme;
