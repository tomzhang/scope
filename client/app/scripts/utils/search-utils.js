import { Map as makeMap } from 'immutable';
import _ from 'lodash';

import { slugify } from './string-utils';

// topolevel search fields
const SEARCH_FIELDS = makeMap({
  label: 'label',
  sublabel: 'label_minor'
});

const COMPARISONS = makeMap({
  '<': 'lt',
  '>': 'gt',
  '=': 'eq'
});
const COMPARISONS_REGEX = new RegExp(`[${COMPARISONS.keySeq().toJS().join('')}]`);

const PREFIX_DELIMITER = ':';

/**
 * Returns a RegExp from a given string. If the string is not a valid regexp,
 * it is escaped. Returned regexp is case-insensitive.
 */
function makeRegExp(expression, options = 'i') {
  try {
    return new RegExp(expression, options);
  } catch (e) {
    return new RegExp(_.escapeRegExp(expression), options);
  }
}

/**
 * Returns the float of a metric value string, e.g. 2 KB -> 2048
 */
function parseValue(value) {
  let parsed = parseFloat(value);
  if ((/k/i).test(value)) {
    parsed *= 1024;
  } else if ((/m/i).test(value)) {
    parsed *= 1024 * 1024;
  } else if ((/g/i).test(value)) {
    parsed *= 1024 * 1024 * 1024;
  } else if ((/t/i).test(value)) {
    parsed *= 1024 * 1024 * 1024 * 1024;
  }
  return parsed;
}

/**
 * True if a prefix matches a field label
 * Slugifies the label (removes all non-alphanumerical chars).
 */
function matchPrefix(label, prefix) {
  if (label && prefix) {
    return (makeRegExp(prefix)).test(slugify(label));
  }
  return false;
}

/**
 * Adds a match to nodeMatches under the keyPath. The text is matched against
 * the query. If a prefix is given, it is matched against the label (skip on
 * no match).
 * Returns a new instance of nodeMatches.
 */
function findNodeMatch(nodeMatches, keyPath, text, query, prefix, label) {
  if (!prefix || matchPrefix(label, prefix)) {
    const queryRe = makeRegExp(query);
    const matches = text.match(queryRe);
    if (matches) {
      const firstMatch = matches[0];
      const index = text.search(queryRe);
      nodeMatches = nodeMatches.setIn(keyPath,
        {text, label, start: index, length: firstMatch.length});
    }
  }
  return nodeMatches;
}

/**
 * If the metric matches the field's label and the value compares positively
 * with the comp operator, a nodeMatch is added
 */
function findNodeMatchMetric(nodeMatches, keyPath, fieldValue, fieldLabel, metric, comp, value) {
  if (slugify(metric) === slugify(fieldLabel)) {
    let matched = false;
    switch (comp) {
      case 'gt': {
        if (fieldValue > value) {
          matched = true;
        }
        break;
      }
      case 'lt': {
        if (fieldValue < value) {
          matched = true;
        }
        break;
      }
      case 'eq': {
        if (fieldValue === value) {
          matched = true;
        }
        break;
      }
      default: {
        break;
      }
    }
    if (matched) {
      nodeMatches = nodeMatches.setIn(keyPath,
        {fieldLabel, metric: true});
    }
  }
  return nodeMatches;
}


export function searchTopology(nodes, { prefix, query, metric, comp, value }) {
  let nodeMatches = makeMap();
  nodes.forEach((node, nodeId) => {
    if (query) {
      // top level fields
      SEARCH_FIELDS.forEach((field, label) => {
        const keyPath = [nodeId, label];
        if (node.has(field)) {
          nodeMatches = findNodeMatch(nodeMatches, keyPath, node.get(field),
            query, prefix, label);
        }
      });

      // metadata
      if (node.get('metadata')) {
        node.get('metadata').forEach(field => {
          const keyPath = [nodeId, 'metadata', field.get('id')];
          nodeMatches = findNodeMatch(nodeMatches, keyPath, field.get('value'),
            query, prefix, field.get('label'));
        });
      }

      // parents and relatives
      if (node.get('parents')) {
        node.get('parents').forEach(parent => {
          const keyPath = [nodeId, 'parents', parent.get('id')];
          nodeMatches = findNodeMatch(nodeMatches, keyPath, parent.get('label'),
            query, prefix, parent.get('topologyId'));
        });
      }

      // tables (envvars and labels)
      const tables = node.get('tables');
      if (tables) {
        tables.forEach((table) => {
          if (table.get('rows')) {
            table.get('rows').forEach(field => {
              const keyPath = [nodeId, 'tables', field.get('id')];
              nodeMatches = findNodeMatch(nodeMatches, keyPath, field.get('value'),
                query, prefix, field.get('label'));
            });
          }
        });
      }
    } else if (metric) {
      const metrics = node.get('metrics');
      if (metrics) {
        metrics.forEach(field => {
          const keyPath = [nodeId, 'metrics', field.get('id')];
          nodeMatches = findNodeMatchMetric(nodeMatches, keyPath, field.get('value'),
            field.get('label'), metric, comp, value);
        });
      }
    }
  });
  return nodeMatches;
}

/**
 * Returns an object with fields depending on the query:
 * parseQuery('text') -> {query: 'text'}
 * parseQuery('p:text') -> {query: 'text', prefix: 'p'}
 * parseQuery('cpu > 1') -> {metric: 'cpu', value: '1', comp: 'gt'}
 */
export function parseQuery(query) {
  if (query) {
    const prefixQuery = query.split(PREFIX_DELIMITER);
    const isPrefixQuery = prefixQuery && prefixQuery.length === 2;

    if (isPrefixQuery) {
      const prefix = prefixQuery[0].trim();
      query = prefixQuery[1].trim();
      if (prefix && query) {
        return {
          query,
          prefix
        };
      }
    } else if (COMPARISONS_REGEX.test(query)) {
      // check for comparisons
      let comparison;
      COMPARISONS.forEach((comp, delim) => {
        const comparisonQuery = query.split(delim);
        if (comparisonQuery && comparisonQuery.length === 2) {
          const value = parseValue(comparisonQuery[1]);
          const metric = comparisonQuery[0].trim();
          if (!isNaN(value) && metric) {
            comparison = {
              metric,
              value,
              comp
            };
            return false; // dont look further
          }
        }
        return true;
      });
      if (comparison) {
        return comparison;
      }
    } else {
      return { query };
    }
  }
  return null;
}

/**
 * Returns {topologyId: {nodeId: matches}}
 */
export function updateNodeMatches(state) {
  const parsed = parseQuery(state.get('searchQuery'));
  if (parsed) {
    if (state.has('nodesByTopology')) {
      state.get('nodesByTopology').forEach((nodes, topologyId) => {
        const nodeMatches = searchTopology(nodes, parsed);
        if (nodeMatches.size > 0) {
          state = state.setIn(['searchNodeMatches', topologyId], nodeMatches);
        } else {
          state = state.deleteIn(['searchNodeMatches', topologyId]);
        }
      });
    }
  } else if (state.has('searchNodeMatches')) {
    state = state.update('searchNodeMatches', snm => snm.clear());
  }

  return state;
}

/**
 * Set `filtered:true` in state's nodes if a pinned search matches
 */
export function applyPinnedSearches(state) {
  // clear old filter state
  state = state.update('nodes',
    nodes => nodes.map(node => node.set('filtered', false)));

  const pinnedSearches = state.get('pinnedSearches');
  if (pinnedSearches.size > 0) {
    state.get('pinnedSearches').forEach(query => {
      const parsed = parseQuery(query);
      if (parsed) {
        const nodeMatches = searchTopology(state.get('nodes'), parsed);
        const filteredNodes = state.get('nodes')
          .map(node => node.set('filtered',
            node.get('filtered') // matched by previous pinned search
            || nodeMatches.size === 0 // no match, filter all nodes
            || !nodeMatches.has(node.get('id')))); // filter matches
        state = state.set('nodes', filteredNodes);
      }
    });
  }

  return state;
}

export const testable = {
  applyPinnedSearches,
  findNodeMatch,
  findNodeMatchMetric,
  matchPrefix,
  makeRegExp,
  parseQuery,
  parseValue,
  searchTopology,
  updateNodeMatches
};
