import { useQuery } from '@tanstack/react-query'
import { getKids } from '../lib/kids'

interface KidSelectorProps {
  value: string
  onChange: (kidId: string) => void
}

export function KidSelector({ value, onChange }: KidSelectorProps) {
  const { data: kids } = useQuery({
    queryKey: ['kids'],
    queryFn: getKids,
  })

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700">Kid</label>
      <div className="mt-2 flex gap-2">
        {(kids ?? []).map((kid) => (
          <button
            key={kid.id}
            type="button"
            onClick={() => onChange(kid.id)}
            className={`rounded-full px-5 py-2 text-sm font-medium transition-colors ${
              value === kid.id
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {kid.name}
          </button>
        ))}
      </div>
    </div>
  )
}
