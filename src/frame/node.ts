// O binary node: a unidade do WABinary. Um `<tag attrs>conteúdo</tag>` onde o
// conteúdo é texto, bytes, ou uma lista de outros nodes.

export interface BinaryNode {
  tag: string;
  attrs: Record<string, string>;
  content?: BinaryNode[] | Uint8Array | string;
}

export function node(
  tag: string,
  attrs: Record<string, string> = {},
  content?: BinaryNode["content"],
): BinaryNode {
  return { tag, attrs, content };
}

// Acesso conveniente, no estilo da Baileys.
export function getBinaryNodeChildren(parent: BinaryNode | undefined, tag: string): BinaryNode[] {
  if (parent && Array.isArray(parent.content)) {
    return parent.content.filter((c) => c.tag === tag);
  }
  return [];
}

export function getBinaryNodeChild(parent: BinaryNode | undefined, tag: string): BinaryNode | undefined {
  return getBinaryNodeChildren(parent, tag)[0];
}
