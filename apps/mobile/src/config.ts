/** The API's address. Set EXPO_PUBLIC_API_URL for anything but local development. */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/** Mastra Studio, for links from a run to its trace (development only). */
export const STUDIO_URL = process.env.EXPO_PUBLIC_STUDIO_URL ?? 'http://localhost:4000';
