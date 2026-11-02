// Node module hook: lets the Deno-style Edge Function sources run under Node
// for end-to-end tests by mapping `npm:` specifiers to installed packages.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('npm:')) {
    const bare = specifier.slice(4).replace(/^(@[^/]+\/[^@/]+|[^@/]+)@[^/]+/, '$1');
    return next(bare, context);
  }
  return next(specifier, context);
}
