import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import ENV from '../config/env';

// Claves de almacenamiento seguro
export const TOKEN_KEYS = {
  ACCESS: 'access_token',
  REFRESH: 'refresh_token',
};

// Instancia base de Axios
const apiClient = axios.create({
  baseURL: ENV.API_URL,
  timeout: ENV.API_TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Control de cola para evitar múltiples refresh simultáneos
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// 1. INTERCEPTOR DE PETICIÓN: Inyecta el Access Token
apiClient.interceptors.request.use(
  async (config) => {
    const accessToken = await SecureStore.getItemAsync(TOKEN_KEYS.ACCESS);
    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// 2. INTERCEPTOR DE RESPUESTA: Maneja expiración (401) y rotación de doble JWT
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Si el error es 401 y no es un reintento ni la propia ruta de refresh
    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !originalRequest.url.includes('/auth/refresh')
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((newToken) => {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            return apiClient(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = await SecureStore.getItemAsync(TOKEN_KEYS.REFRESH);

        if (!refreshToken) {
          throw new Error('No hay refresh token disponible');
        }

        // Petición directa con axios limpio para evitar ciclos infinitos
        const { data } = await axios.post(`${ENV.API_URL}/auth/refresh`, {
          refreshToken,
        });

        // Guardar el nuevo par de tokens (rotación de doble JWT)
        await SecureStore.setItemAsync(TOKEN_KEYS.ACCESS, data.accessToken);
        if (data.refreshToken) {
          await SecureStore.setItemAsync(TOKEN_KEYS.REFRESH, data.refreshToken);
        }

        apiClient.defaults.headers.common.Authorization = `Bearer ${data.accessToken}`;
        originalRequest.headers.Authorization = `Bearer ${data.accessToken}`;

        processQueue(null, data.accessToken);
        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        // Limpiar sesión si el refresh token también expiró
        await SecureStore.deleteItemAsync(TOKEN_KEYS.ACCESS);
        await SecureStore.deleteItemAsync(TOKEN_KEYS.REFRESH);
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default apiClient;