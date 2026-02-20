'use client';

import {
  Box, Button, Center, Heading, Text, VStack, Card, CardBody,
  Input, FormControl, FormLabel, FormErrorMessage,
  Tabs, TabList, TabPanels, Tab, TabPanel, useToast, InputGroup,
  InputRightElement, IconButton, HStack,
} from '@chakra-ui/react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useCallback } from 'react';
import { FaEye, FaEyeSlash } from 'react-icons/fa';

interface Captcha {
  question: string;
  captchaToken: string;
}

export default function SignInPage() {
  const { status } = useSession();
  const router = useRouter();
  const toast = useToast();

  // Shared state
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [tabIndex, setTabIndex] = useState(0);

  // Login state
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  // Register state
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [regError, setRegError] = useState('');

  useEffect(() => {
    if (status === 'authenticated') router.push('/');
  }, [status, router]);

  const fetchCaptcha = useCallback(async () => {
    try {
      const res = await fetch('/meet/api/auth/captcha');
      const data = await res.json();
      setCaptcha(data);
      setCaptchaAnswer('');
    } catch {
      toast({ title: 'Failed to load captcha', status: 'error', duration: 3000 });
    }
  }, [toast]);

  useEffect(() => {
    fetchCaptcha();
  }, [fetchCaptcha]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    if (!captcha) return;

    setLoading(true);
    try {
      const result = await signIn('credentials', {
        redirect: false,
        email: loginEmail,
        password: loginPassword,
        captchaToken: captcha.captchaToken,
        captchaAnswer,
      });

      if (result?.error) {
        setLoginError('Invalid email, password, or captcha');
        fetchCaptcha();
      } else {
        router.push('/');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError('');

    if (regPassword !== regConfirm) {
      setRegError('Passwords do not match');
      return;
    }
    if (regPassword.length < 8) {
      setRegError('Password must be at least 8 characters');
      return;
    }
    if (!captcha) return;

    setLoading(true);
    try {
      const res = await fetch('/meet/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: regEmail,
          password: regPassword,
          name: regName,
          captchaToken: captcha.captchaToken,
          captchaAnswer: Number(captchaAnswer),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setRegError(typeof data.error === 'string' ? data.error : 'Registration failed');
        fetchCaptcha();
        return;
      }

      // Switch to login tab after successful registration
      toast({ title: 'Account created! Please log in.', status: 'success', duration: 3000 });
      setLoginEmail(regEmail);
      setRegName('');
      setRegEmail('');
      setRegPassword('');
      setRegConfirm('');
      setTabIndex(0);
      fetchCaptcha();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box minH="100vh" bg="gray.900">
      <Center h="100vh" px={{ base: 4, md: 0 }}>
        <Card
          bg="meeting.surface"
          border="1px"
          borderColor="whiteAlpha.200"
          w={{ base: '100%', sm: '440px' }}
          maxW="440px"
        >
          <CardBody p={{ base: 6, md: 8 }}>
            <VStack spacing={5}>
              <VStack spacing={2}>
                <Heading
                  size={{ base: 'lg', md: 'xl' }}
                  bgGradient="linear(to-r, brand.400, brand.600)"
                  bgClip="text"
                >
                  Confera
                </Heading>
                <Text color="gray.400" fontSize="sm" textAlign="center">
                  Video conferencing with breakout rooms, Q&A, and more
                </Text>
              </VStack>

              <Tabs w="full" variant="soft-rounded" colorScheme="brand" index={tabIndex} onChange={(i) => { setTabIndex(i); setLoginError(''); setRegError(''); fetchCaptcha(); }}>
                <TabList mb={4}>
                  <Tab flex={1} color="gray.400" _selected={{ color: 'white', bg: 'brand.500' }}>Login</Tab>
                  <Tab flex={1} color="gray.400" _selected={{ color: 'white', bg: 'brand.500' }}>Register</Tab>
                </TabList>

                <TabPanels>
                  {/* LOGIN TAB */}
                  <TabPanel p={0}>
                    <form onSubmit={handleLogin}>
                      <VStack spacing={4}>
                        <FormControl isRequired>
                          <FormLabel color="gray.300" fontSize="sm">Email</FormLabel>
                          <Input
                            type="email"
                            value={loginEmail}
                            onChange={(e) => setLoginEmail(e.target.value)}
                            bg="whiteAlpha.100"
                            borderColor="whiteAlpha.300"
                            color="white"
                            _placeholder={{ color: 'gray.500' }}
                            placeholder="you@example.com"
                          />
                        </FormControl>

                        <FormControl isRequired>
                          <FormLabel color="gray.300" fontSize="sm">Password</FormLabel>
                          <InputGroup>
                            <Input
                              type={showPassword ? 'text' : 'password'}
                              value={loginPassword}
                              onChange={(e) => setLoginPassword(e.target.value)}
                              bg="whiteAlpha.100"
                              borderColor="whiteAlpha.300"
                              color="white"
                              placeholder="Enter password"
                              _placeholder={{ color: 'gray.500' }}
                            />
                            <InputRightElement>
                              <IconButton
                                aria-label="Toggle password"
                                icon={showPassword ? <FaEyeSlash /> : <FaEye />}
                                size="sm"
                                variant="ghost"
                                color="gray.400"
                                onClick={() => setShowPassword(!showPassword)}
                              />
                            </InputRightElement>
                          </InputGroup>
                        </FormControl>

                        {captcha && (
                          <FormControl isRequired>
                            <FormLabel color="gray.300" fontSize="sm">
                              What is {captcha.question} ?
                            </FormLabel>
                            <Input
                              type="number"
                              value={captchaAnswer}
                              onChange={(e) => setCaptchaAnswer(e.target.value)}
                              bg="whiteAlpha.100"
                              borderColor="whiteAlpha.300"
                              color="white"
                              placeholder="Your answer"
                              _placeholder={{ color: 'gray.500' }}
                            />
                          </FormControl>
                        )}

                        {loginError && (
                          <Text color="red.400" fontSize="sm">{loginError}</Text>
                        )}

                        <Button
                          type="submit"
                          w="full"
                          colorScheme="brand"
                          size="lg"
                          isLoading={loading}
                        >
                          Sign In
                        </Button>
                      </VStack>
                    </form>
                  </TabPanel>

                  {/* REGISTER TAB */}
                  <TabPanel p={0}>
                    <form onSubmit={handleRegister}>
                      <VStack spacing={4}>
                        <FormControl isRequired>
                          <FormLabel color="gray.300" fontSize="sm">Full Name</FormLabel>
                          <Input
                            value={regName}
                            onChange={(e) => setRegName(e.target.value)}
                            bg="whiteAlpha.100"
                            borderColor="whiteAlpha.300"
                            color="white"
                            placeholder="John Doe"
                            _placeholder={{ color: 'gray.500' }}
                          />
                        </FormControl>

                        <FormControl isRequired>
                          <FormLabel color="gray.300" fontSize="sm">Email</FormLabel>
                          <Input
                            type="email"
                            value={regEmail}
                            onChange={(e) => setRegEmail(e.target.value)}
                            bg="whiteAlpha.100"
                            borderColor="whiteAlpha.300"
                            color="white"
                            placeholder="you@example.com"
                            _placeholder={{ color: 'gray.500' }}
                          />
                        </FormControl>

                        <FormControl isRequired>
                          <FormLabel color="gray.300" fontSize="sm">Password</FormLabel>
                          <InputGroup>
                            <Input
                              type={showPassword ? 'text' : 'password'}
                              value={regPassword}
                              onChange={(e) => setRegPassword(e.target.value)}
                              bg="whiteAlpha.100"
                              borderColor="whiteAlpha.300"
                              color="white"
                              placeholder="Min 8 characters"
                              _placeholder={{ color: 'gray.500' }}
                            />
                            <InputRightElement>
                              <IconButton
                                aria-label="Toggle password"
                                icon={showPassword ? <FaEyeSlash /> : <FaEye />}
                                size="sm"
                                variant="ghost"
                                color="gray.400"
                                onClick={() => setShowPassword(!showPassword)}
                              />
                            </InputRightElement>
                          </InputGroup>
                        </FormControl>

                        <FormControl isRequired>
                          <FormLabel color="gray.300" fontSize="sm">Confirm Password</FormLabel>
                          <Input
                            type="password"
                            value={regConfirm}
                            onChange={(e) => setRegConfirm(e.target.value)}
                            bg="whiteAlpha.100"
                            borderColor="whiteAlpha.300"
                            color="white"
                            placeholder="Re-enter password"
                            _placeholder={{ color: 'gray.500' }}
                          />
                        </FormControl>

                        {captcha && (
                          <FormControl isRequired>
                            <FormLabel color="gray.300" fontSize="sm">
                              What is {captcha.question} ?
                            </FormLabel>
                            <Input
                              type="number"
                              value={captchaAnswer}
                              onChange={(e) => setCaptchaAnswer(e.target.value)}
                              bg="whiteAlpha.100"
                              borderColor="whiteAlpha.300"
                              color="white"
                              placeholder="Your answer"
                              _placeholder={{ color: 'gray.500' }}
                            />
                          </FormControl>
                        )}

                        {regError && (
                          <Text color="red.400" fontSize="sm">{regError}</Text>
                        )}

                        <Button
                          type="submit"
                          w="full"
                          colorScheme="brand"
                          size="lg"
                          isLoading={loading}
                        >
                          Create Account
                        </Button>
                      </VStack>
                    </form>
                  </TabPanel>
                </TabPanels>
              </Tabs>

              <HStack spacing={1}>
                <Text fontSize="xs" color="gray.500" cursor="pointer" onClick={fetchCaptcha} _hover={{ color: 'gray.300' }}>
                  Refresh captcha
                </Text>
              </HStack>
            </VStack>
          </CardBody>
        </Card>
      </Center>
    </Box>
  );
}
