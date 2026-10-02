export class InvalidOperationError extends Error {}

export const MAX_OPERATION_COMPONENTS = 1000;

function isRetain(component) {
  return component?.retain !== undefined;
}

function isInsert(component) {
  return component?.insert !== undefined;
}

function isDelete(component) {
  return component?.delete !== undefined;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function getComponentLength(component) {
  if (isInsert(component)) {
    return component.insert.length;
  }
  return isRetain(component) ? component.retain : component.delete;
}

function shortenComponent(component, consumedLength) {
  const remainingLength = getComponentLength(component) - consumedLength;
  if (remainingLength === 0) {
    return undefined;
  }
  return isRetain(component) ? { retain: remainingLength } : { delete: remainingLength };
}

function createOperationBuilder() {
  const components = [];

  return {
    retain(length) {
      if (length <= 0) {
        return;
      }
      const lastComponent = components.at(-1);
      if (isRetain(lastComponent)) {
        lastComponent.retain += length;
      } else {
        components.push({ retain: length });
      }
    },

    insert(text) {
      if (text.length === 0) {
        return;
      }
      const lastComponent = components.at(-1);
      const componentBeforeLast = components.at(-2);
      if (isInsert(lastComponent)) {
        lastComponent.insert += text;
      } else if (isDelete(lastComponent) && isInsert(componentBeforeLast)) {
        componentBeforeLast.insert += text;
      } else if (isDelete(lastComponent)) {
        components.splice(components.length - 1, 0, { insert: text });
      } else {
        components.push({ insert: text });
      }
    },

    delete(length) {
      if (length <= 0) {
        return;
      }
      const lastComponent = components.at(-1);
      if (isDelete(lastComponent)) {
        lastComponent.delete += length;
      } else {
        components.push({ delete: length });
      }
    },

    build() {
      return components;
    },
  };
}

export function parseOperation(rawOperation) {
  if (!Array.isArray(rawOperation)) {
    throw new InvalidOperationError("L'opération doit être une liste de composants");
  }
  if (rawOperation.length > MAX_OPERATION_COMPONENTS) {
    throw new InvalidOperationError(`Une opération ne doit pas dépasser ${MAX_OPERATION_COMPONENTS} composants`);
  }

  const operationBuilder = createOperationBuilder();
  for (const rawComponent of rawOperation) {
    const componentKeys = rawComponent && typeof rawComponent === 'object' ? Object.keys(rawComponent) : [];
    if (componentKeys.length !== 1) {
      throw new InvalidOperationError('Chaque composant doit contenir exactement retain, insert ou delete');
    }

    if (isPositiveInteger(rawComponent.retain)) {
      operationBuilder.retain(rawComponent.retain);
    } else if (typeof rawComponent.insert === 'string' && rawComponent.insert.length > 0) {
      operationBuilder.insert(rawComponent.insert);
    } else if (isPositiveInteger(rawComponent.delete)) {
      operationBuilder.delete(rawComponent.delete);
    } else {
      throw new InvalidOperationError('Composant invalide : retain et delete sont des entiers positifs, insert un texte non vide');
    }
  }
  return operationBuilder.build();
}

export function getBaseLength(operation) {
  let baseLength = 0;
  for (const component of operation) {
    if (!isInsert(component)) {
      baseLength += getComponentLength(component);
    }
  }
  return baseLength;
}

export function applyOperation(content, operation) {
  if (getBaseLength(operation) !== content.length) {
    throw new InvalidOperationError("La longueur de base de l'opération ne correspond pas au document");
  }

  const contentParts = [];
  let contentPosition = 0;
  for (const component of operation) {
    if (isRetain(component)) {
      contentParts.push(content.slice(contentPosition, contentPosition + component.retain));
      contentPosition += component.retain;
    } else if (isInsert(component)) {
      contentParts.push(component.insert);
    } else {
      contentPosition += component.delete;
    }
  }
  return contentParts.join('');
}

export function transformOperation(priorityOperation, concurrentOperation) {
  if (getBaseLength(priorityOperation) !== getBaseLength(concurrentOperation)) {
    throw new InvalidOperationError('Les deux opérations ne partent pas du même document');
  }

  const transformedPriorityBuilder = createOperationBuilder();
  const transformedConcurrentBuilder = createOperationBuilder();
  let priorityIndex = 0;
  let concurrentIndex = 0;
  let priorityComponent = priorityOperation[priorityIndex++];
  let concurrentComponent = concurrentOperation[concurrentIndex++];

  while (priorityComponent !== undefined || concurrentComponent !== undefined) {
    if (isInsert(priorityComponent)) {
      transformedPriorityBuilder.insert(priorityComponent.insert);
      transformedConcurrentBuilder.retain(priorityComponent.insert.length);
      priorityComponent = priorityOperation[priorityIndex++];
      continue;
    }

    if (isInsert(concurrentComponent)) {
      transformedPriorityBuilder.retain(concurrentComponent.insert.length);
      transformedConcurrentBuilder.insert(concurrentComponent.insert);
      concurrentComponent = concurrentOperation[concurrentIndex++];
      continue;
    }

    const consumedLength = Math.min(getComponentLength(priorityComponent), getComponentLength(concurrentComponent));
    if (isRetain(priorityComponent) && isRetain(concurrentComponent)) {
      transformedPriorityBuilder.retain(consumedLength);
      transformedConcurrentBuilder.retain(consumedLength);
    } else if (isDelete(priorityComponent) && isRetain(concurrentComponent)) {
      transformedPriorityBuilder.delete(consumedLength);
    } else if (isRetain(priorityComponent) && isDelete(concurrentComponent)) {
      transformedConcurrentBuilder.delete(consumedLength);
    }

    priorityComponent = shortenComponent(priorityComponent, consumedLength) ?? priorityOperation[priorityIndex++];
    concurrentComponent = shortenComponent(concurrentComponent, consumedLength) ?? concurrentOperation[concurrentIndex++];
  }

  return [transformedPriorityBuilder.build(), transformedConcurrentBuilder.build()];
}

export function transformIndex(index, operation) {
  let basePosition = 0;
  let transformedIndex = index;
  for (const component of operation) {
    if (basePosition > index) {
      break;
    }
    if (isRetain(component)) {
      basePosition += component.retain;
    } else if (isInsert(component)) {
      transformedIndex += component.insert.length;
    } else {
      transformedIndex -= Math.min(component.delete, index - basePosition);
      basePosition += component.delete;
    }
  }
  return transformedIndex;
}
