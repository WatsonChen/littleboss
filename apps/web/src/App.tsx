import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApiClient } from './api';
import { getToken, setToken } from './lib/auth';
import { Room } from './views/Room';
import { ThreadList } from './views/ThreadList';
import { TokenGate } from './views/TokenGate';

const ROOM = /^#\/t\/([0-9a-f-]{36})(?:\/r\/([0-9a-f-]{36}))?$/i;

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const [locked, setLocked] = useState(false);
  const [triedToken, setTriedToken] = useState(false);
  // Changing the key remounts the screens so they load again with the new password.
  const [epoch, setEpoch] = useState(0);

  const onUnauthorized = useCallback(() => setLocked(true), []);
  const client = useMemo(() => createApiClient({ getToken, onUnauthorized }), [onUnauthorized]);

  if (locked) {
    return (
      <TokenGate
        wrong={triedToken}
        onSubmit={(t) => {
          setToken(t);
          setTriedToken(true);
          setLocked(false);
          setEpoch((e) => e + 1);
        }}
      />
    );
  }

  const room = ROOM.exec(hash);
  return room ? (
    <Room
      key={`${room[1]}-${room[2] ?? ''}-${epoch}`}
      client={client}
      threadId={room[1]!}
      openRunId={room[2] ?? null}
    />
  ) : (
    <ThreadList key={epoch} client={client} />
  );
}
