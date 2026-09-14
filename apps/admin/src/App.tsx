import { useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  AppShell,
  Container,
  Group,
  MantineProvider,
  Select,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Title,
  useMantineColorScheme,
} from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import {
  IconArrowsExchange,
  IconEngine,
  IconFiles,
  IconMapPin,
  IconMoon,
  IconPalette,
  IconPhotoScan,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconSun,
  IconUpload,
  IconUsers,
} from '@tabler/icons-react';
import { api } from './api';
import type { Machine } from './types';
import { notifyError } from './notify';
import { theme } from './theme';
import { IngestView } from './IngestView';
import { ColorIngestView } from './ColorIngestView';
import { BatchIngest } from './BatchIngest';
import { BlobIngest } from './BlobIngest';
import { DotEditor } from './DotEditor';
import { BrowseView } from './BrowseView';
import { SubstitutesView } from './SubstitutesView';
import { AssistantView } from './AssistantView';
import { SettingsView } from './SettingsView';
import { CustomersView } from './CustomersView';

function NeedMachine() {
  return <Text c="dimmed">Select a machine (top-right), or create one in the Browse tab, to continue.</Text>;
}

function ColorSchemeToggle() {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  return (
    <ActionIcon
      variant="default"
      size="lg"
      aria-label="Toggle color scheme"
      onClick={() => toggleColorScheme()}
    >
      {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
    </ActionIcon>
  );
}

function Shell() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineId, setMachineIdState] = useState(() => localStorage.getItem('wemo.machineId') ?? '');
  const [tab, setTabState] = useState<string | null>(() => localStorage.getItem('wemo.tab') || 'ingest');
  const [refreshKey, setRefreshKey] = useState(0);

  const setMachineId = (id: string) => {
    setMachineIdState(id);
    localStorage.setItem('wemo.machineId', id);
  };
  const setTab = (t: string | null) => {
    setTabState(t);
    if (t) localStorage.setItem('wemo.tab', t);
  };

  const refreshMachines = useCallback(async () => {
    try {
      const m = await api.listMachines();
      setMachines(m);
      // Keep the persisted selection only if it still exists; otherwise first machine.
      setMachineIdState((cur) => (m.some((x) => x.id === cur) ? cur : m[0]?.id ?? ''));
    } catch (e) {
      notifyError('Could not load machines', String(e));
    }
  }, []);

  useEffect(() => {
    void refreshMachines();
  }, [refreshMachines]);

  const bump = () => setRefreshKey((v) => v + 1);

  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group justify="space-between" align="center" h="100%" px="md">
          <Group gap="xs">
            <ThemeIcon size="md" radius="md" variant="filled">
              <IconEngine size={18} />
            </ThemeIcon>
            <Title order={4}>wemo · admin</Title>
          </Group>
          <Group gap="sm">
            <Select
              placeholder="Select machine"
              data={machines.map((m) => ({ value: m.id, label: `${m.brand} ${m.model}` }))}
              value={machineId || null}
              onChange={(v) => setMachineId(v ?? '')}
              searchable
              w={280}
              nothingFoundMessage="No machines — create one in Browse"
            />
            <ColorSchemeToggle />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="lg">
          <Stack gap="md">
            <Tabs value={tab} onChange={setTab} keepMounted={false}>
              <Tabs.List>
                <Tabs.Tab value="ingest" leftSection={<IconPhotoScan size={16} />}>
                  Ingest page
                </Tabs.Tab>
                <Tabs.Tab value="batch" leftSection={<IconFiles size={16} />}>
                  Batch (PDF)
                </Tabs.Tab>
                <Tabs.Tab value="blob" leftSection={<IconUpload size={16} />}>
                  Blob file
                </Tabs.Tab>
                <Tabs.Tab value="color" leftSection={<IconPalette size={16} />}>
                  Color index
                </Tabs.Tab>
                <Tabs.Tab value="dots" leftSection={<IconMapPin size={16} />}>
                  Dot mapping
                </Tabs.Tab>
                <Tabs.Tab value="browse" leftSection={<IconSearch size={16} />}>
                  Browse
                </Tabs.Tab>
                <Tabs.Tab value="substitutes" leftSection={<IconArrowsExchange size={16} />}>
                  Substitutes
                </Tabs.Tab>
                <Tabs.Tab value="assistant" leftSection={<IconSparkles size={16} />}>
                  Assistant
                </Tabs.Tab>
                <Tabs.Tab value="customers" leftSection={<IconUsers size={16} />}>
                  CRM
                </Tabs.Tab>
                <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
                  Settings
                </Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="ingest" pt="md">
                {machineId ? <IngestView machineId={machineId} onCommitted={bump} /> : <NeedMachine />}
              </Tabs.Panel>
              <Tabs.Panel value="batch" pt="md">
                {machineId ? <BatchIngest machineId={machineId} onCommitted={bump} /> : <NeedMachine />}
              </Tabs.Panel>
              <Tabs.Panel value="blob" pt="md">
                {machineId ? <BlobIngest machineId={machineId} onCommitted={bump} /> : <NeedMachine />}
              </Tabs.Panel>
              <Tabs.Panel value="color" pt="md">
                {machineId ? <ColorIngestView machineId={machineId} onCommitted={bump} /> : <NeedMachine />}
              </Tabs.Panel>
              <Tabs.Panel value="dots" pt="md">
                {machineId ? <DotEditor machineId={machineId} refreshKey={refreshKey} /> : <NeedMachine />}
              </Tabs.Panel>
              <Tabs.Panel value="browse" pt="md">
                <BrowseView
                  machineId={machineId}
                  machine={machines.find((m) => m.id === machineId)}
                  refreshKey={refreshKey}
                  onMachinesChanged={refreshMachines}
                  onGoToIngest={() => setTab('ingest')}
                />
              </Tabs.Panel>
              <Tabs.Panel value="substitutes" pt="md">
                <SubstitutesView />
              </Tabs.Panel>
              <Tabs.Panel value="assistant" pt="md" keepMounted>
                <AssistantView />
              </Tabs.Panel>
              <Tabs.Panel value="customers" pt="md">
                <CustomersView />
              </Tabs.Panel>
              <Tabs.Panel value="settings" pt="md">
                <SettingsView />
              </Tabs.Panel>
            </Tabs>
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}

export function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications position="top-right" />
      <Shell />
    </MantineProvider>
  );
}
