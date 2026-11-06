import { Navigate, useLocation } from 'react-router';

/** Old links keep working: moves to the new path and keeps `?plan=` and any other parameters. */
export function Redirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}
