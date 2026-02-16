import { Routes, Route, Navigate } from 'react-router-dom'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Layout } from './components/Layout'
import Dashboard from './pages/Dashboard'
import Login from './pages/Login'
import Simulator from './pages/Simulator'
import AddMoney from './pages/AddMoney'
import Invest from './pages/Invest'
import Spend from './pages/Spend'
import Settings from './pages/Settings'
import { useAuth } from './hooks/useAuth'

function App() {
  const { user, loading } = useAuth()

  return (
    <Routes>
      <Route
        path="/login"
        element={
          loading ? null : user ? <Navigate to="/" replace /> : <Login />
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout>
              <Dashboard />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/add-money"
        element={
          <ProtectedRoute>
            <Layout>
              <AddMoney />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/kid/:kidId/invest"
        element={
          <ProtectedRoute>
            <Layout>
              <Invest />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/spend"
        element={
          <ProtectedRoute>
            <Layout>
              <Spend />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/simulator"
        element={
          <ProtectedRoute>
            <Layout>
              <Simulator />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <Layout>
              <Settings />
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default App
