import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { reverseMovement } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fmtSigned, MOVEMENT_LABELS } from '@/lib/format';
import type { StockMovement } from '@/lib/types';
import { useInvalidateInventory } from '@/hooks/data';
import { ConfirmDialog } from '../ui/Modal';
import { Textarea } from '../ui/Field';

/** Audit policy: erroneous movements are never edited — an admin records a reversing adjustment. */
export function ReverseDialog({ movement, onClose }: { movement: StockMovement | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const invalidate = useInvalidateInventory();
  const m = useMutation({
    mutationFn: () => reverseMovement(movement!.id, reason),
    onSuccess: async () => {
      toast.success(`Movement #${movement!.id} reversed.`);
      setReason('');
      onClose();
      await invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <ConfirmDialog
      open={Boolean(movement)}
      title={`Reverse movement #${movement?.id ?? ''}?`}
      message={
        movement && (
          <>
            This records a new adjustment of <b className="text-ink">{fmtSigned(-movement.quantity_change)}</b> for <b className="text-ink">{movement.product_name}</b>, cancelling
            the original {MOVEMENT_LABELS[movement.movement_type].toLowerCase()} entry. The original record is kept for audit purposes.
          </>
        )
      }
      confirmLabel="Record reversal"
      loading={m.isPending}
      onCancel={() => {
        setReason('');
        setError(undefined);
        onClose();
      }}
      onConfirm={() => {
        if (!reason.trim()) {
          setError('A reason is required');
          return;
        }
        m.mutate();
      }}
    >
      <Textarea label="Reason for reversal" required maxLength={400} value={reason} error={error} onChange={(e) => { setReason(e.target.value); setError(undefined); }} />
    </ConfirmDialog>
  );
}
