import { useState, useEffect, useCallback, useRef } from 'react';
import { getPendingSyncCount, getUnsyncedDraftCount } from '../data/offlineStore';
import { triggerSync } from '../data/syncStore';

/**
 * useOfflineSync — Phase 1: Offline-First Mobile Sync Hook
 * 
 * Tracks online/offline state, pending sync count, and provides
 * auto-sync on reconnect with debounce protection.
 */
export function useOfflineSync({ autoSync = true, debounceMs = 2000 } = {}) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [lastSyncResult, setLastSyncResult] = useState(null);
  const debounceRef = useRef(null);
  const mountedRef = useRef(true);

  // Refresh pending count
  const refreshPendingCount = useCallback(async () => {
    try {
      const qCount = await getPendingSyncCount();
      const dCount = await getUnsyncedDraftCount();
      if (mountedRef.current) setPendingCount(qCount + dCount);
    } catch (e) {
      // Silent — offline or DB error
    }
  }, []);

  // Perform sync
  const syncNow = useCallback(async () => {
    if (isSyncing || !navigator.onLine) return { processed: 0 };
    
    setIsSyncing(true);
    try {
      const result = await triggerSync();
      if (mountedRef.current) {
        setLastSyncTime(new Date());
        setLastSyncResult(result);
        await refreshPendingCount();
      }
      return result;
    } catch (err) {
      console.error('[OfflineSync] Sync failed:', err);
      if (mountedRef.current) setLastSyncResult({ error: err.message });
      return { processed: 0, error: err.message };
    } finally {
      if (mountedRef.current) setIsSyncing(false);
    }
  }, [isSyncing, refreshPendingCount]);

  // Debounced auto-sync on reconnect
  const debouncedSync = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      syncNow();
    }, debounceMs);
  }, [syncNow, debounceMs]);

  // Online/offline listeners
  useEffect(() => {
    mountedRef.current = true;

    const handleOnline = () => {
      setIsOnline(true);
      if (autoSync) debouncedSync();
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    const handleSyncStarted = () => {
      if (mountedRef.current) setIsSyncing(true);
    };

    const handleSyncCompleted = () => {
      if (mountedRef.current) {
        setIsSyncing(false);
        setLastSyncTime(new Date());
        refreshPendingCount();
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('syncStarted', handleSyncStarted);
    window.addEventListener('syncCompleted', handleSyncCompleted);

    // Initial pending count
    refreshPendingCount();

    return () => {
      mountedRef.current = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('syncStarted', handleSyncStarted);
      window.removeEventListener('syncCompleted', handleSyncCompleted);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [autoSync, debouncedSync, refreshPendingCount]);

  // Poll pending count every 30 seconds
  useEffect(() => {
    const interval = setInterval(refreshPendingCount, 30000);
    return () => clearInterval(interval);
  }, [refreshPendingCount]);

  const getSyncState = useCallback(() => {
    if (!isOnline) return { status: 'saved_device', label: 'Saved on this device' };
    if (isSyncing) return { status: 'syncing', label: 'Syncing' };
    if (lastSyncResult?.error) return { status: 'failed', label: 'Sync failed' };
    if (pendingCount > 0) return { status: 'waiting', label: 'Waiting to sync' };
    return { status: 'synced', label: 'Synced to school database' };
  }, [isOnline, isSyncing, lastSyncResult, pendingCount]);

  return {
    isOnline,
    pendingCount,
    isSyncing,
    lastSyncTime,
    lastSyncResult,
    syncState: getSyncState().status,
    syncLabel: getSyncState().label,
    syncNow,
    refreshPendingCount,
  };
}

/**
 * OfflineSyncBadge — Compact inline indicator component
 * Shows online/offline status with pending sync count.
 */
export function OfflineSyncBadge({ isOnline, pendingCount, isSyncing, onSync }) {
  if (isOnline && pendingCount === 0 && !isSyncing) return null;

  const badgeStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 12px',
    borderRadius: 20,
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.3px',
    cursor: onSync ? 'pointer' : 'default',
    transition: 'all 0.3s ease',
    border: '1px solid',
    ...(isSyncing
      ? { background: '#EFF6FF', color: '#2563EB', borderColor: '#93C5FD' }
      : !isOnline
        ? { background: '#FEF2F2', color: '#DC2626', borderColor: '#FECACA' }
        : { background: '#FFFBEB', color: '#D97706', borderColor: '#FDE68A' }),
  };

  const dotStyle = {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: isSyncing ? '#2563EB' : !isOnline ? '#DC2626' : '#D97706',
    animation: isSyncing ? 'pulse 1.2s infinite' : !isOnline ? 'pulse 2s infinite' : 'none',
  };

  return (
    <span style={badgeStyle} onClick={onSync} title={isSyncing ? 'Syncing...' : !isOnline ? 'Offline' : `${pendingCount} pending`}>
      <span style={dotStyle} />
      {isSyncing ? 'Syncing' : !isOnline ? 'Saved on this device' : pendingCount > 0 ? 'Waiting to sync' : 'Synced to school database'}
      <style>{`@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }`}</style>
    </span>
  );
}

export default useOfflineSync;
