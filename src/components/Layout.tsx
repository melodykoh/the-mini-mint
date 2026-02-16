import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard' },
  { path: '/add-money', label: 'Add Money' },
  { path: '/spend', label: 'Spend' },
  { path: '/simulator', label: 'Simulator' },
  { path: '/settings', label: 'Settings' },
]

export function Layout({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuth()
  const location = useLocation()

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <nav className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-4xl px-4">
          <div className="flex h-14 items-center justify-between">
            <Link to="/" className="text-lg font-bold text-gray-900">
              Mini Mint
            </Link>
            <div className="flex items-center gap-1 overflow-x-auto">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    location.pathname === item.path
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
            <button
              onClick={signOut}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="mx-auto max-w-4xl p-4">{children}</main>
    </div>
  )
}
