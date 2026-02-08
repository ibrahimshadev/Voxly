const rawAppName = import.meta.env.VITE_APP_NAME?.trim();

export const APP_NAME = rawAppName && rawAppName.length > 0 ? rawAppName : 'Voxly';
