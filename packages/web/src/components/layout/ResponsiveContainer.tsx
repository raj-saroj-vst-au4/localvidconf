// =============================================================================
// Responsive Container
// Utility wrapper that applies consistent responsive max-widths and padding
// across all pages. Maps to our 5 breakpoints:
// - base (320px): full width, minimal padding
// - sm (480px): 95% width
// - md (768px): 90% width
// - lg (1024px): 1000px max
// - xl (1440px): 1200px max
// =============================================================================

'use client';

import { Container } from '@chakra-ui/react';

interface ResponsiveContainerProps {
  children: React.ReactNode;
  fullWidth?: boolean; // If true, skip max-width constraint
}

export default function ResponsiveContainer({
  children,
  fullWidth = false,
}: ResponsiveContainerProps) {
  return (
    <Container
      maxW={fullWidth
        ? '100%'
        : { base: '100%', sm: '95%', md: '90%', lg: '1000px', xl: '1200px' }
      }
      px={{ base: 3, sm: 4, md: 6 }}
      py={{ base: 4, md: 6, lg: 8 }}
    >
      {children}
    </Container>
  );
}
