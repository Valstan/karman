import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest } from '../api/client';
import type {
  AuthUser,
  BankRow,
  CreditRow,
  DashboardSummary,
  DocumentRow,
} from '../types';

export type AppData = {
  currentUser: AuthUser | null;
  authLoading: boolean;
  banks: BankRow[];
  credits: CreditRow[];
  documents: DocumentRow[];
  summary: DashboardSummary | null;
  loadingData: boolean;
  loadError: string | null;
  refreshAuth: () => Promise<AuthUser | null>;
  loadAllData: () => Promise<void>;
  logout: () => Promise<void>;
};

const EMPTY_DATA = {
  banks: [] as BankRow[],
  credits: [] as CreditRow[],
  documents: [] as DocumentRow[],
  summary: null as DashboardSummary | null,
};

export function useAppData(): AppData {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [banks, setBanks] = useState<BankRow[]>([]);
  const [credits, setCredits] = useState<CreditRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const authOk = currentUser !== null;

  const resetData = useCallback(() => {
    setBanks(EMPTY_DATA.banks);
    setCredits(EMPTY_DATA.credits);
    setDocuments(EMPTY_DATA.documents);
    setSummary(EMPTY_DATA.summary);
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const user = await apiRequest<AuthUser>('/api/v1/auth/me');
      setCurrentUser(user);
      return user;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setCurrentUser(null);
        return null;
      }
      throw error;
    }
  }, []);

  const loadAllData = useCallback(async () => {
    if (!authOk) {
      return;
    }
    setLoadingData(true);
    setLoadError(null);
    try {
      const [banksData, creditsData, documentsData, summaryData] = await Promise.all([
        apiRequest<BankRow[]>('/api/v1/credits/banks/'),
        apiRequest<CreditRow[]>('/api/v1/credits/credits/'),
        apiRequest<DocumentRow[]>('/api/v1/documents/'),
        apiRequest<DashboardSummary>('/api/v1/dashboard/summary/'),
      ]);
      setBanks(banksData);
      setCredits(creditsData);
      setDocuments(documentsData);
      setSummary(summaryData);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setCurrentUser(null);
        resetData();
        return;
      }
      setLoadError((error as Error).message || 'Ошибка загрузки данных');
    } finally {
      setLoadingData(false);
    }
  }, [authOk, resetData]);

  const logout = useCallback(async () => {
    try {
      await apiRequest<{ status: string }>('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // best-effort logout
    } finally {
      setCurrentUser(null);
      resetData();
    }
  }, [resetData]);

  useEffect(() => {
    let active = true;
    const bootstrapAuth = async () => {
      setAuthLoading(true);
      try {
        await refreshAuth();
      } catch (error) {
        if (active) {
          setLoadError((error as Error).message || 'Ошибка проверки авторизации');
        }
      } finally {
        if (active) {
          setAuthLoading(false);
        }
      }
    };
    void bootstrapAuth();
    return () => {
      active = false;
    };
  }, [refreshAuth]);

  useEffect(() => {
    if (authOk) {
      void loadAllData();
    }
  }, [authOk, loadAllData]);

  return {
    currentUser,
    authLoading,
    banks,
    credits,
    documents,
    summary,
    loadingData,
    loadError,
    refreshAuth,
    loadAllData,
    logout,
  };
}
