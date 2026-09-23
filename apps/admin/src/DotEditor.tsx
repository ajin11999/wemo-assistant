import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  FileButton,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconDeviceFloppy, IconMapPin, IconPhotoUp, IconTrash } from '@tabler/icons-react';
import { api, imageUrl } from './api';
import { b64of, fileToDataUrl, imageMeta } from './ingest-helpers';
import { notifyError, notifySuccess } from './notify';
import type { Assembly, EditorDot, FullItem } from './types';

export function DotEditor({ machineId, refreshKey }: { machineId: string; refreshKey: number }) {
  const [assemblies, setAssemblies] = useState<Assembly[]>([]);
  const [asmId, setAsmId] = useState<string | null>(null);
  const [items, setItems] = useState<FullItem[]>([]);
  const [dots, setDots] = useState<EditorDot[]>([]);
  const [selItem, setSelItem] = useState('');
  const [hasImage, setHasImage] = useState(false);
  const [imgV, setImgV] = useState(0);
  const [busy, setBusy] = useState<'idle' | 'uploading' | 'saving'>('idle');
  const [confirmClear, setConfirmClear] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  const currentAsm = useMemo(() => assemblies.find((a) => a.id === asmId), [assemblies, asmId]);

  useEffect(() => {
    setAsmId(null);
    setItems([]);
    setDots([]);
    api.listAssemblies(machineId).then(setAssemblies).catch((e) => notifyError('Could not load assemblies', String(e)));
  }, [machineId, refreshKey]);

  async function openAssembly(id: string | null) {
    setAsmId(id);
    if (!id) return;
    try {
      const full = await api.getAssemblyFull(id);
      setItems(full.items);
      setSelItem(full.items[0]?.id ?? '');
      setDots(full.items.flatMap((it) => it.dots.map((d) => ({ assemblyItemId: it.id, x: d.x, y: d.y }))));
      setHasImage(!!full.assembly.imageRef);
      setImgV((v) => v + 1);
    } catch (e) {
      notifyError('Could not load assembly', String(e));
    }
  }

  const refByItem = useMemo(() => new Map(items.map((it) => [it.id, it.refNo])), [items]);
  const dotsForItem = (id: string) => dots.filter((d) => d.assemblyItemId === id).length;

  function onCanvasClick(e: MouseEvent<HTMLDivElement>) {
    if (!selItem || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    setDots((d) => [...d, { assemblyItemId: selItem, x, y }]);
  }
  function removeDot(idx: number, e: MouseEvent) {
    e.stopPropagation();
    setDots((d) => d.filter((_, i) => i !== idx));
  }

  async function onImage(file: File | null) {
    if (!file || !asmId) return;
    setBusy('uploading');
    try {
      const dataUrl = await fileToDataUrl(file);
      const { b64, mediaType } = b64of(dataUrl);
      const { w, h } = await imageMeta(dataUrl);
      await api.uploadAssemblyImage(asmId, b64, mediaType, w, h);
      setHasImage(true);
      setImgV((v) => v + 1);
      notifySuccess('Image uploaded');
    } catch (e2) {
      notifyError('Upload failed', String(e2));
    } finally {
      setBusy('idle');
    }
  }

  async function save() {
    if (!asmId) return;
    setBusy('saving');
    try {
      const r = await api.saveDots(asmId, dots);
      notifySuccess(`Saved ${r.count} dots`);
    } catch (e) {
      notifyError('Save failed', String(e));
    } finally {
      setBusy('idle');
    }
  }

  function handleClearCanvas() {
    setDots([]);
    setConfirmClear(false);
    notifySuccess('Cleared dots from canvas. Click "Save dots" when ready.');
  }

  async function handleClearAndSave() {
    if (!asmId) return;
    setDots([]);
    setConfirmClear(false);
    setBusy('saving');
    try {
      await api.saveDots(asmId, []);
      notifySuccess('Cleared and saved 0 dots to database');
    } catch (e) {
      notifyError('Clear failed', String(e));
    } finally {
      setBusy('idle');
    }
  }

  return (
    <Stack>
      <Card withBorder>
        <Group justify="space-between" wrap="wrap">
          <Group>
            <Select
              placeholder="Select assembly"
              data={assemblies.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))}
              value={asmId}
              onChange={openAssembly}
              searchable
              w={360}
            />
            {asmId && (
              <>
                <FileButton onChange={onImage} accept="image/*">
                  {(props) => (
                    <Button
                      variant="default"
                      leftSection={<IconPhotoUp size={16} />}
                      loading={busy === 'uploading'}
                      {...props}
                    >
                      Upload diagram
                    </Button>
                  )}
                </FileButton>
                <Text size="sm" c="dimmed">
                  {hasImage ? 'diagram loaded' : 'no diagram yet — upload one'}
                </Text>
              </>
            )}
          </Group>
          {asmId && (
            <Group>
              <Button
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={() => setConfirmClear(true)}
                disabled={dots.length === 0}
              >
                Clear all dots ({dots.length})
              </Button>
              <Button
                leftSection={<IconDeviceFloppy size={16} />}
                onClick={save}
                loading={busy === 'saving'}
                disabled={!hasImage}
              >
                Save dots
              </Button>
            </Group>
          )}
        </Group>
      </Card>

      <Modal
        opened={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear all dots?"
        centered
        size="sm"
      >
        <Stack gap="sm">
          <Text size="sm">
            Are you sure you want to clear all <strong>{dots.length}</strong> dots for{' '}
            <strong>{currentAsm?.code} · {currentAsm?.name}</strong>?
          </Text>
          <Text size="xs" c="dimmed">
            You can clear the canvas to start placing dots fresh, or clear and save immediately to remove them from the database.
          </Text>
          <Group justify="flex-end" gap="xs" mt="md">
            <Button variant="default" size="xs" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button variant="light" color="red" size="xs" onClick={handleClearCanvas}>
              Clear canvas
            </Button>
            <Button color="red" size="xs" onClick={handleClearAndSave} loading={busy === 'saving'}>
              Clear & save now
            </Button>
          </Group>
        </Stack>
      </Modal>

      {asmId && (
        <Card withBorder>
          <Stack gap="sm">
            <Text size="xs" c="dimmed">
              Pick a ref on the left, then click the diagram to drop its dot. Click a dot to remove it.
            </Text>
            <Group align="flex-start" wrap="nowrap">
              <ScrollArea h={520} w={280} type="auto">
                {items.length === 0 ? (
                  <Stack align="center" gap={6} pt="xl">
                    <ThemeIcon variant="light" size="lg" radius="xl">
                      <IconMapPin size={20} />
                    </ThemeIcon>
                    <Text size="sm" c="dimmed" ta="center">
                      No positions — commit a page for this assembly first.
                    </Text>
                  </Stack>
                ) : (
                  <Stack gap={4}>
                    {items.map((it) => (
                      <Button
                        key={it.id}
                        fullWidth
                        size="xs"
                        justify="space-between"
                        variant={it.id === selItem ? 'filled' : 'default'}
                        rightSection={
                          <Badge size="xs" variant="light">
                            {dotsForItem(it.id)}
                          </Badge>
                        }
                        onClick={() => setSelItem(it.id)}
                        styles={{ label: { overflow: 'hidden', textOverflow: 'ellipsis' } }}
                      >
                        {it.refNo} · {it.part?.nameRaw ?? ''}
                      </Button>
                    ))}
                  </Stack>
                )}
              </ScrollArea>

              <Box style={{ flex: 1 }}>
                {hasImage ? (
                  <div className="canvas" ref={canvasRef} onClick={onCanvasClick}>
                    <img src={`${imageUrl(asmId)}?v=${imgV}`} alt="diagram" draggable={false} />
                    {dots.map((d, i) => (
                      <div
                        key={i}
                        className="marker"
                        style={{ left: `${d.x * 100}%`, top: `${d.y * 100}%` }}
                        title="click to remove"
                        onClick={(e) => removeDot(i, e)}
                      >
                        {refByItem.get(d.assemblyItemId) ?? '?'}
                      </div>
                    ))}
                  </div>
                ) : (
                  <Stack align="center" gap={6} pt="xl">
                    <ThemeIcon variant="light" size="lg" radius="xl">
                      <IconPhotoUp size={20} />
                    </ThemeIcon>
                    <Text size="sm" c="dimmed">
                      Upload a diagram image to start placing dots.
                    </Text>
                  </Stack>
                )}
              </Box>
            </Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
