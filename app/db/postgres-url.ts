/**
 * PlanetScale URLs include `sslrootcert=system`, which tells libpq to use
 * the OS trust store. node-postgres treats that value as a file path, so
 * drop it and verify the certificate with Node's CA store instead.
 */
export function postgresUrlForNode(connectionString: string): string {
  const url = new URL(connectionString)
  if (url.searchParams.get('sslrootcert') === 'system') {
    url.searchParams.delete('sslrootcert')
  }
  return url.toString()
}
