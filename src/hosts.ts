export const normaliseHost = (host: string) => host.toLowerCase().replace(/\.$/, '');
export const isLocalHost = (host: string) => {
  const h = normaliseHost(host);
  return h === 'localhost' || h.endsWith('.localhost');
};
