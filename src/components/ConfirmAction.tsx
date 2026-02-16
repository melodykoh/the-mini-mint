import type { ActionSummary } from '../hooks/useActionFlow'

interface ConfirmActionProps {
  summary: ActionSummary
  variant?: 'default' | 'destructive'
  isSubmitting: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmAction({
  summary,
  variant = 'default',
  isSubmitting,
  error,
  onConfirm,
  onCancel,
}: ConfirmActionProps) {
  const isDestructive = variant === 'destructive'
  const confirmColor = isDestructive
    ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
    : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'

  return (
    <div
      className={`rounded-xl border-2 p-5 ${
        isDestructive ? 'border-red-200 bg-red-50' : 'border-blue-200 bg-blue-50'
      }`}
    >
      <h3 className="text-base font-semibold text-gray-900">
        {summary.title}
      </h3>

      <dl className="mt-3 space-y-1">
        {summary.details.map((detail, i) => (
          <dd key={i} className="text-sm text-gray-700">
            {detail}
          </dd>
        ))}
      </dl>

      {summary.balanceImpact && (
        <p className="mt-3 text-sm font-medium text-gray-900">
          {summary.balanceImpact}
        </p>
      )}

      {summary.warning && (
        <p
          className={`mt-3 text-sm font-medium ${
            isDestructive ? 'text-red-700' : 'text-amber-700'
          }`}
        >
          {summary.warning}
        </p>
      )}

      {error && (
        <div className="mt-3 rounded-md bg-red-100 p-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="flex-1 rounded-md border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isSubmitting}
          className={`flex-1 rounded-md px-4 py-3 text-sm font-medium text-white shadow-sm focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:opacity-50 ${confirmColor}`}
        >
          {isSubmitting ? 'Processing...' : 'Confirm'}
        </button>
      </div>
    </div>
  )
}
