interface MoneyInputProps {
  value: string
  onChange: (value: string) => void
  label: string
  id: string
  placeholder?: string
}

export function MoneyInput({
  value,
  onChange,
  label,
  id,
  placeholder = '0.00',
}: MoneyInputProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      <div className="relative mt-1">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
          $
        </span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="block w-full rounded-md border border-gray-300 py-3 pl-7 pr-3 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          placeholder={placeholder}
        />
      </div>
    </div>
  )
}
