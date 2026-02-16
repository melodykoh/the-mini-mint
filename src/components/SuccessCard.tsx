import { Link } from 'react-router-dom'

interface SuccessCardProps {
  message: string
  kidId?: string
  onDoAnother: () => void
}

export function SuccessCard({ message, kidId, onDoAnother }: SuccessCardProps) {
  return (
    <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-6 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
        <svg
          className="h-6 w-6 text-emerald-600"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4.5 12.75l6 6 9-13.5"
          />
        </svg>
      </div>

      <p className="mt-4 text-sm font-medium text-emerald-800">{message}</p>

      <div className="mt-6 flex flex-col gap-2">
        <button
          type="button"
          onClick={onDoAnother}
          className="w-full rounded-md bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
        >
          Do Another
        </button>
        {kidId && (
          <Link
            to={`/kid/${kidId}/history`}
            className="w-full rounded-md border border-gray-300 bg-white px-4 py-3 text-center text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            View History
          </Link>
        )}
      </div>
    </div>
  )
}
