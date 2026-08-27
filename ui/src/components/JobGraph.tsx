import type { JSX } from 'react';

import type { JobGraph as Graph, GraphNode } from '../api';

/**
 * Граф работ по зависимостям — как стадии в gitlab: колонка на уровень,
 * узлы столбиком, связи кривыми между ними.
 *
 * Раскладку считает демон: колонка и строка приходят в снимке. Здесь остаётся
 * геометрия — перевести номера в координаты и провести кривые.
 */

const NODE_WIDTH = 168;
const NODE_HEIGHT = 46;
const GAP_X = 72;
const GAP_Y = 16;
const PADDING = 8;

function x(column: number): number {
  return PADDING + column * (NODE_WIDTH + GAP_X);
}

function y(row: number): number {
  return PADDING + row * (NODE_HEIGHT + GAP_Y);
}

/** Связь ведётся кривой Безье: прямые углы между колонками читаются хуже. */
function edgePath(from: GraphNode, to: GraphNode): string {
  const x1 = x(from.column) + NODE_WIDTH;
  const y1 = y(from.row) + NODE_HEIGHT / 2;
  const x2 = x(to.column);
  const y2 = y(to.row) + NODE_HEIGHT / 2;
  const bend = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export interface JobGraphProps {
  readonly graph: Graph;
  readonly selected?: string;
  readonly onSelect?: (id: string) => void;
  /** Подпись под именем работы: статус в прогоне, шаги в пайплайне. */
  readonly subtitle?: (node: GraphNode) => string | undefined;
}

export function JobGraph({ graph, selected, onSelect, subtitle }: JobGraphProps): JSX.Element {
  if (graph.nodes.length === 0) {
    return <p className="note dim">Работ в этом графе нет.</p>;
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const rows = Math.max(...graph.nodes.map((node) => node.row)) + 1;
  const columns = Math.max(...graph.nodes.map((node) => node.column)) + 1;
  const width = x(columns - 1) + NODE_WIDTH + PADDING;
  const height = y(rows - 1) + NODE_HEIGHT + PADDING;

  return (
    <div className="graph">
      <svg width={width} height={height} role="img" aria-label="Граф работ">
        {/*
         * Обрезка по рамке узла. Ни имя работы, ни подпись под ним не
         * ограничены длиной: имя приходит из пайплайна, подпись — из статуса
         * или списка шагов, и достаточно длинной любая из них вылезает за
         * рамку и наезжает на соседний узел. Обрезка внутри перенесённой
         * группы, поэтому одного описания хватает на все узлы.
         */}
        <defs>
          <clipPath id="job-node-box">
            <rect width={NODE_WIDTH - 6} height={NODE_HEIGHT} rx={7} />
          </clipPath>
        </defs>
        {graph.edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (from === undefined || to === undefined) return null;
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              className={edge.blocking ? 'edge blocking' : 'edge'}
              d={edgePath(from, to)}
            >
              {/* Ребро к пропущенной работе называет виновника прямо в подсказке. */}
              <title>
                {edge.blocking
                  ? `${edge.to} отменена исходом ${edge.from}`
                  : `${edge.to} ждёт ${edge.from}`}
              </title>
            </path>
          );
        })}

        {graph.nodes.map((node) => {
          const classes = ['node'];
          if (node.conditional) classes.push('conditional');
          if (node.status !== undefined) classes.push(`status-${node.status}`);
          if (node.id === selected) classes.push('selected');
          const sub = subtitle?.(node);

          return (
            <g
              key={node.id}
              className={classes.join(' ')}
              transform={`translate(${x(node.column)}, ${y(node.row)})`}
              onClick={() => onSelect?.(node.id)}
            >
              <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={7} />
              <text x={10} y={sub === undefined ? 27 : 20} clipPath="url(#job-node-box)">
                {node.id}
              </text>
              {sub === undefined ? null : (
                <text className="sub" x={10} y={35} clipPath="url(#job-node-box)">
                  {sub}
                </text>
              )}
              <title>
                {[
                  node.needs.length === 0 ? 'без зависимостей' : `needs: ${node.needs.join(', ')}`,
                  node.on === 'success' ? undefined : `on: ${node.on}`,
                  node.if === undefined ? undefined : `if: ${node.if}`,
                  node.blockedBy.length === 0
                    ? undefined
                    : `отменена исходом: ${node.blockedBy.join(', ')}`,
                ]
                  .filter((line): line is string => line !== undefined)
                  .join('\n')}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
