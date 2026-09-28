export const extendsComponentQuick = (source: string): boolean => {
  return source.includes('defineComponent');
};

export const createLoaderResult = (contents: string): { contents: string; loader: 'ts' } => ({
  contents,
  loader: 'ts',
});
