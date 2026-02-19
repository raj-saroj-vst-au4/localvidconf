// =============================================================================
// Chakra UI Provider Wrapper
// Wraps the app with ChakraProvider and custom theme
// "use client" because Chakra needs browser APIs (localStorage for color mode)
// =============================================================================

'use client';

import { ChakraProvider as ChakraUIProvider, ColorModeScript } from '@chakra-ui/react';
import theme from '@/styles/theme';

export default function ChakraProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Injects color mode script before hydration to prevent flash */}
      <ColorModeScript initialColorMode={theme.config.initialColorMode} />
      <ChakraUIProvider theme={theme}>
        {children}
      </ChakraUIProvider>
    </>
  );
}
