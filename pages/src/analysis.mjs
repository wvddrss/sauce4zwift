import * as sauce from '../../shared/sauce/index.mjs';
import * as common from './common.mjs';
import * as echarts from '../deps/src/echarts.mjs';
import * as theme from './echarts-sauce-theme.mjs';
import * as map from './map.mjs';
import * as color from './color.mjs';
// XXX
// import * as fieldsMod from './fields.mjs';

common.enableSentry();
echarts.registerTheme('sauce', theme.getTheme('dynamic', {fg: 'intrinsic-inverted', bg: 'intrinsic'}));
common.settingsStore.setDefault({
    preferWkg: false,
    peakEffortSource: 'power',
});

let zwiftMap;
let elevationChart;
let zoomableChart;
let templates;
let athleteData;
let sport;

const state = {
    laps: [],
    segments: [],
    streams: {},
    positions: [],
    startOffset: 0,
    startTime: undefined,
    sport: undefined,
    zoomStart: undefined,
    zoomEnd: undefined,
    paused: false,
    voidAutoCenter: false,
};


const settings = common.settingsStore.get();
const H = sauce.locale.human;
const q = new URLSearchParams(location.search);
const athleteIdent = q.get('id') || 'self';
const chartRefs = new Set();
const minVAMTime = 60;
const rolls = {
    power: new sauce.power.RollingPower(null, {idealGap: 1, maxGap: 15}),
};

const peakFormatters = {
    power: x => H.power(x, {suffix: true, html: true}),
    speed: x => H.pace(x, {suffix: true, html: true, sport}),
    hr: x => H.number(x, {suffix: 'bpm', html: true}),
    draft: x => H.power(x, {suffix: true, html: true}),
};

const zoomableChartSeries = [{
    id: 'power',
    stream: 'power',
    name: 'Power',
    color: '#46f',
    domain: [0, 700],
    rangeAlpha: [0.4, 1],
    fmt: x => H.power(x, {separator: ' ', suffix: true}),
}, {
    id: 'hr',
    stream: 'hr',
    name: 'HR',
    color: '#e22',
    domain: [70, 190],
    rangeAlpha: [0.1, 0.7],
    fmt: x => H.number(x, {suffix: ' bpm'}),
}, {
    id: 'speed',
    stream: 'speed',
    name: x => sport === 'running' ? 'Pace' : 'Speed',
    color: '#4e3',
    domain: [0, 80],
    rangeAlpha: [0.1, 0.8],
    fmt: x => H.pace(x, {suffix: true, separator: ' ', sport}),
}, {
    id: 'cadence',
    stream: 'cadence',
    name: 'Cadence',
    color: '#ee1',
    domain: [0, 140],
    rangeAlpha: [0.1, 0.8],
    fmt: x => H.number(x, {suffix: ' rpm'}),
}, {
    id: 'draft',
    stream: 'draft',
    name: 'Draft',
    color: '#e88853',
    domain: [0, 300],
    rangeAlpha: [0.1, 0.9],
    fmt: x => H.power(x, {separator: ' ', suffix: true}),
}];


async function getTemplates(basenames) {
    return Object.fromEntries(await Promise.all(basenames.map(k =>
        sauce.template.getTemplate(`templates/analysis/${k}.html.tpl`, {html: true}).then(v =>
            // camelCase conv keys-with_snakecase--chars
            [k.replace(/[-_]+(.)/g, (_, x) => x.toUpperCase()), v]))));
}


const _tplSigs = new Map();
async function updateTemplate(selector, tpl, attrs) {
    const html = await tpl(attrs);
    const sig = common.hash(html);
    if (_tplSigs.get(selector) !== sig) {
        _tplSigs.set(selector, sig);
        document.querySelector(selector).outerHTML = html;
    }
}


function getSelectionStats() {
    if (!athleteData) {
        return;
    }
    let powerRoll = rolls.power;
    if (state.zoomStart !== undefined) {
        const start = state.streams.time[state.zoomStart];
        const end = state.streams.time[state.zoomEnd];
        powerRoll = powerRoll.slice(start, end);
    }
    const activeTime = powerRoll.active();
    const elapsedTime = powerRoll.elapsed();
    const powerAvg = powerRoll.avg({active: true});
    const np = powerRoll.np();
    const athlete = athleteData.athlete;
    const rank = athlete?.weight ?
        sauce.power.rank(activeTime, powerAvg, np, athlete.weight, athlete.gender, {darkMode: true}) :
        null;
    const start = state.streams.time.indexOf(powerRoll.firstTime({noPad: true}));
    const end = state.streams.time.indexOf(powerRoll.lastTime({noPad: true})) + 1;
    const distStream = state.streams.distance.slice(start, end);
    const altStream = state.streams.altitude.slice(start, end);
    const hrStream = state.streams.hr.slice(start, end).filter(x => x);
    const distance = distStream[distStream.length - 1] - distStream[0];
    const {gain, loss} = sauce.geo.altitudeChanges(altStream);
    return {
        activeTime,
        elapsedTime,
        athlete,
        sport,
        env: {
            distance,
            speed: distance / 1000 * (3600 / activeTime),
        },
        power: {
            avg: powerAvg,
            max: sauce.data.max(powerRoll.values()),
            np,
            kj: powerRoll.joules() / 1000,
            tss: sauce.power.calcTSS(np > powerAvg ? np : powerAvg, activeTime, athlete?.ftp),
            rank,
        },
        el: {
            gain,
            loss,
            grade: (altStream[altStream.length - 1] - altStream[0]) / distance,
            vam: elapsedTime >= minVAMTime ? (gain / elapsedTime) * 3600 : 0,
        },
        hr: hrStream.length ? {
            avg: sauce.data.avg(hrStream),
            max: sauce.data.max(hrStream),
        } : null
    };
}


async function updateSelectionStats() {
    const selectionStats = getSelectionStats();
    await updateTemplate('.selection-stats', templates.selectionStats, {selectionStats});
}


async function exportFITActivity(name) {
    const fitData = await common.rpc.exportFIT(athleteIdent);
    const f = new File([new Uint8Array(fitData)], `${name}.fit`, {type: 'application/binary'});
    const l = document.createElement('a');
    l.download = f.name;
    l.style.display = 'none';
    l.href = URL.createObjectURL(f);
    try {
        document.body.appendChild(l);
        l.click();
    } finally {
        URL.revokeObjectURL(l.href);
        l.remove();
    }
}


function createElevationLineChart(el) {
    const series = [{
        id: 'altitude',
        stream: 'altitude',
        name: 'Elevation',
        color: '#666',
        domain: [null, 30],
        rangeAlpha: [0.4, 1],
        fmt: x => H.elevation(x, {separator: ' ', suffix: true}),
    }];
    const xAxes = [0];
    const chart = echarts.init(el, 'sauce', {renderer: 'svg'});
    const topPad = 10;
    const seriesPad = 1;
    const bottomPad = 20;
    const leftPad = 6;
    const rightPad = 6;
    let updateDeferred;

    const options = {
        animation: false, // slow and we want a responsive interface not a pretty static one
        color: series.map(f => f.color),
        legend: {show: false},  // required for sauceLegned to toggle series
        grid: series.map((x, i) => {
            const count = series.length;
            return {
                top: `${topPad + i / count * (100 - topPad - bottomPad)}%`,
                height: `${(100 - topPad - bottomPad) / count - seriesPad}%`,
                left: leftPad,
                right: rightPad,
            };
        }),
        brush: {
            seriesIndex: xAxes,
            xAxisIndex: xAxes,
            brushType: 'lineX',
            brushMode: 'single',
            brushStyle: {
                color: 'var(--selection-color)',
                borderWidth: 'var(--selection-border-width)',
                borderColor: 'var(--selection-border-color)',
            },
        },
        xAxis: series.map((f, i) => ({
            show: true,
            type: 'value',
            min: 'dataMin',
            max: 'dataMax',
            gridIndex: i,
            splitLine: {show: false},
            axisLine: {show: false},
            axisLabel: {
                showMinLabel: false,
                showMaxLabel: false,
                formatter: x => H.distance(x, {suffix: true}),
                padding: [-4, 0, 0, 0],
            },
            axisPointer: {
                show: true,
                label: {show: false},
            },
        })),
        yAxis: series.map((f, i) => ({
            show: false,
            type: 'value',
            gridIndex: i,
            min: x => f.domain[0] != null ? Math.min(f.domain[0], x.min) : x.min,
            max: x => f.domain[1] != null ? Math.max(f.domain[1], x.max) : x.max,
            splitNumber: undefined,
            interval: Infinity, // disable except for min/max
            splitLine: {show: false},
        })),
        series: series.map((f, i) => ({
            type: 'line',
            animation: false,
            showSymbol: false,
            emphasis: {disabled: true},
            id: f.id,
            name: typeof f.name === 'function' ? f.name() : f.name,
            z: series.length - i + 1,
            xAxisIndex: i,
            yAxisIndex: i,
            tooltip: {valueFormatter: f.fmt},
            areaStyle: {
                origin: 'start',
                color: new echarts.graphic.LinearGradient(0, 1, 0, 0, [{
                    offset: 0,
                    color: theme.cssColor('intrinsic', 0.3, 0.5)
                }, {
                    offset: 0.9,
                    color: theme.cssColor('intrinsic', 0.1, 0.1)
                }]),
            },
            lineStyle: {
                color: theme.cssColor('intrinsic', 0.3),
                width: 1,
            },
        })),
        toolbox: {show: false},
    };
    chart.setOption(options);
    // This is the only way to enable brush selection by default. :/
    chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: {
            brushType: 'lineX',
            brushMode: 'single',
        }
    });

    chart.updateData = () => {
        if (state.paused) {
            updateDeferred = true;
            return;
        }
        updateDeferred = false;
        chart.setOption({
            series: series.map(f => ({
                data: state.streams[f.stream].map((x, i) =>
                    i >= state.startOffset ? [state.streams.distance[i], x] : [null, null]),
            }))
        });
    };

    chart.on('brush', ev => {
        state.paused = !!ev.areas.length;
        if (ev.fromSauce) {
            return;
        }
        if (!ev.areas.length) {
            state.zoomStart = undefined;
            state.zoomEnd = undefined;
            return;
        }
        const range = ev.areas[0].coordRange;
        state.zoomStart = common.binarySearchClosest(state.streams.distance, range[0]);
        state.zoomEnd = common.binarySearchClosest(state.streams.distance, range[1]);
    });
    chart.on('brushEnd', ev => {
        state.paused = false;
        if (updateDeferred) {
            // Must queue callback to prevent conflict with other mouseup actions.
            requestAnimationFrame(chart.updateData);
        }
    });
    chartRefs.add(new WeakRef(chart));
    return chart;
}


function createZoomableLineChart(el) {
    const series = zoomableChartSeries;
    const xAxes = series.map((x, i) => i);
    const chart = echarts.init(el, 'sauce', {renderer: 'svg'});
    const topPad = 3;
    const seriesPad = 1;
    const bottomPad = 8;
    const leftPad = 36;  // tuned to axisLabel rotate of 55
    const rightPad = 20;
    let updateDeferred;

    const options = {
        animation: false, // slow and we want a responsive interface not a pretty static one
        color: series.map(f => f.color),
        legend: {show: false},  // required for sauceLegned to toggle series
        visualMap: series.map((f, i) => ({
            show: false,
            type: 'continuous',
            hoverLink: false,
            seriesIndex: i,
            min: f.domain[0],
            max: f.domain[1],
            inRange: {colorAlpha: f.rangeAlpha},
        })),
        grid: series.map((x, i) => {
            const count = series.length;
            return {
                top: `${topPad + i / count * (100 - topPad - bottomPad)}%`,
                height: `${(100 - topPad - bottomPad) / count - seriesPad}%`,
                left: leftPad,
                right: rightPad,
            };
        }),
        dataZoom: [{
            type: 'inside',
            xAxisIndex: xAxes,
            zoomOnMouseWheel: false,
            moveOnMouseMove: false,
            moveOnMouseWheel: false,
            preventDefaultMouseMove: true,
            zoomLock: true, // workaround for https://github.com/apache/echarts/issues/10079
        }],
        brush: {
            seriesIndex: xAxes,
            xAxisIndex: xAxes,
            brushType: 'lineX',
            brushMode: 'single',
            brushStyle: {
                color: 'var(--selection-color)',
                borderWidth: 'var(--selection-border-width)',
                borderColor: 'var(--selection-border-color)',
            },
        },
        axisPointer: {
            link: [{xAxisIndex: 'all'}],
        },
        xAxis: series.map((f, i) => ({
            gridIndex: i,
            type: 'time',
            splitLine: {show: false},
            axisTick: {show: i === series.length - 1},
            axisLabel: {
                padding: [-4, 0, 0, 0],
                show: i === series.length - 1,
                formatter: t => H.timer(t / 1000),
            },
            axisPointer: {
                snap: true,
                show: true,
                label: {
                    show: true,
                    formatter: x => f.fmt(x.seriesData[0]?.value?.[1]),
                    padding: [5, 5],
                    margin: -20,
                    fontSize: 12, // must use px to get proper bg alignment
                },
            },
        })),
        yAxis: series.map((f, i) => ({
            type: 'value',
            name: typeof f.name === 'function' ? f.name() : f.name,
            nameLocation: 'end',
            nameRotate: 0,
            nameGap: -12,
            nameTextStyle: {
                fontSize: '0.65em',
                fontWeight: 600,
                fontFamily: 'inherit',
                align: 'left',
                padding: [0, 0, 0, 4],
            },
            gridIndex: i,
            min: x => f.domain[0] != null ? Math.min(f.domain[0], x.min) : x.min,
            max: x => f.domain[1] != null ? Math.max(f.domain[1], x.max) : x.max,
            splitNumber: undefined,
            interval: Infinity, // disable except for min/max
            axisLine: {show: true},
            splitLine: {show: false},
            axisLabel: {
                rotate: 45,
                showMinLabel: false,
                formatter: H.number,
            },
        })),
        series: series.map((f, i) => ({
            type: 'line',
            animation: false,
            showSymbol: false,
            emphasis: {disabled: true},
            id: f.id,
            name: typeof f.name === 'function' ? f.name() : f.name,
            z: series.length - i + 1,
            xAxisIndex: i,
            yAxisIndex: i,
            tooltip: {valueFormatter: f.fmt},
            areaStyle: {},
            lineStyle: {
                color: f.color,
                width: 1
            },
        })),
        toolbox: {show: false},
    };
    chart.setOption(options);
    // This is the only way to enable brush selection by default. :/
    chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: {
            brushType: 'lineX',
            brushMode: 'single',
        }
    });

    chart.updateData = () => {
        if (state.paused) {
            updateDeferred = true;
            return;
        }
        updateDeferred = false;
        chart.setOption({
            dataZoom: state.zoomStart !== undefined ? [{
                startValue: state.streams.time[state.zoomStart] * 1000,
                endValue: state.streams.time[state.zoomEnd] * 1000,
            }] : [],
            series: series.map(f => ({
                data: state.streams[f.stream].map((x, i) => [state.streams.time[i] * 1000, x]),
            }))
        });
    };

    chart.on('brush', ev => {
        state.paused = !!ev.areas.length;
        if (ev.fromSauce) {
            return;
        }
        const range = ev.areas[0].coordRange;
        state.zoomStart = common.binarySearchClosest(state.streams.time, range[0] / 1000);
        state.zoomEnd = common.binarySearchClosest(state.streams.time, range[1] / 1000);
    });
    chart.on('brushEnd', ev => {
        state.paused = false;
        const range = ev.areas[0].coordRange;
        // Convert the brush to a zoom...
        chart.dispatchAction({type: 'brush', fromSauce: true, areas: []});  // clear selection
        chart.setOption({dataZoom: [{startValue: range[0], endValue: range[1]}]});
        if (updateDeferred) {
            // Must queue callback to prevent conflict with other mouseup actions.
            requestAnimationFrame(chart.updateData);
        }
    });
    el.addEventListener('click', () => {
        // Only triggered when brush never selects data, i.e. naked click, so clear...
        state.paused = false;
        state.zoomStart = undefined;
        state.zoomEnd = undefined;
        chart.dispatchAction({type: 'dataZoom', start: 0, end: 100});
    });
    chartRefs.add(new WeakRef(chart));
    return chart;
}


function resizeCharts() {
    for (const r of chartRefs) {
        const c = r.deref();
        if (!c) {
            chartRefs.delete(r);
        } else {
            c.resize();
        }
    }
}


function powerZoneColors(zones, fn) {
    const colors = {};
    for (const [k, v] of Object.entries(common.getPowerZoneColors(zones))) {
        const c = color.parse(v);
        colors[k] = fn ? fn(c) : c;
    }
    return colors;
}


async function createTimeInPowerZonesPie(el, renderer) {
    const chart = echarts.init(el, 'sauce', {renderer: 'svg'});
    chart.setOption({
        title: {
            text: 'TIME IN ZONES',
            left: 'center',
            textStyle: {
                fontWeight: 450,
                fontFamily: 'inherit',
                fontSize: '0.76em',
            }
        },
        tooltip: {
            className: 'ec-tooltip'
        },
        series: [{
            type: 'pie',
            radius: ['30%', '80%'],
            top: 10,
            minShowLabelAngle: 20,
            label: {
                show: true,
                position: 'inner',
            },
            tooltip: {
                valueFormatter: x => H.timer(x, {long: true})
            },
            emphasis: {
                itemStyle: {
                    shadowBlur: 10,
                    shadowOffsetX: 0,
                    shadowColor: 'rgba(0, 0, 0, 0.5)'
                }
            }
        }],
    });
    chartRefs.add(new WeakRef(chart));
    let colors;
    let aid;
    let normZones;
    const powerZones = await common.rpc.getPowerZones(1);
    renderer.addCallback(data => {
        if (!data || !data.stats || !data.athlete || !data.athlete.ftp) {
            return;
        }
        if (data.athleteId !== aid) {
            aid = data.athleteId;
            colors = powerZoneColors(powerZones, c => ({
                c,
                g: new echarts.graphic.LinearGradient(0, 0, 1, 1, [
                    {offset: 0, color: c.toString()},
                    {offset: 1, color: c.alpha(0.6).toString()}
                ])
            }));
            normZones = new Set(powerZones.filter(x => !x.overlap).map(x => x.zone));
        }
        chart.setOption({
            series: [{
                data: data.timeInPowerZones.filter(x => normZones.has(x.zone)).map(x => ({
                    name: x.zone,
                    value: x.time,
                    label: {color: colors[x.zone].c.l > 0.65 ? '#000b' : '#fffb'},
                    itemStyle: {color: colors[x.zone].g},
                })),
            }],
        });
    });
}


function centerMap(positions) {
    const xMin = sauce.data.min(positions.map(x => x[0]));
    const yMin = sauce.data.min(positions.map(x => x[1]));
    const xMax = sauce.data.max(positions.map(x => x[0]));
    const yMax = sauce.data.max(positions.map(x => x[1]));
    zwiftMap.setBounds([xMin, yMax], [xMax, yMin]);
}


export async function main() {
    common.initInteractionListeners();
    addEventListener('resize', resizeCharts);
    const [_ad, _templates, nationFlags, worldList] = await Promise.all([
        common.rpc.getAthleteData(athleteIdent),
        getTemplates([
            'main',
            'activity-summary',
            'selection-stats',
            'peak-efforts',
            'segments',
            'laps'
        ]),
        common.initNationFlags(),
        common.getWorldList(),
    ]);
    athleteData = _ad;
    templates = _templates;
    const contentEl = document.querySelector('#content');
    contentEl.innerHTML = await templates.main({
        ...state,
        athleteData,
        templates,
        nationFlags,
        worldList,
        settings,
        common,
        peakFormatters,
    });
    if (!athleteData) {
        return;
    }
    sport = athleteData.state.sport;
    const renderer = new common.Renderer(contentEl, {fps: 1});
    /*renderer.addRotatingFields({
        mapping: [{
            id: 'testing-1',
            default: 'grade',
        }],
        fields: fieldsMod.fields
    });*/
    const exportBtn = document.querySelector('.button.export-file');
    exportBtn.removeAttribute('disabled');
    exportBtn.addEventListener('click', () => {
        // XXX nope.  athletedata becomses stale over time...
        const started = new Date(Date.now() - athleteData.stats.elapsedTime * 1000);
        const athlete = athleteData.athlete;
        const name = `${athlete ? athlete.fLast : athleteIdent} - ${started.toLocaleString()}`;
        exportFITActivity(name);
    });
    elevationChart = createElevationLineChart(contentEl.querySelector('.chart-holder.elevation .chart'));
    zoomableChart = createZoomableLineChart(contentEl.querySelector('.chart-holder.zoomable .chart'));
    createTimeInPowerZonesPie(contentEl.querySelector('.time-in-power-zones'), renderer);  // bg okay
    zwiftMap = new map.SauceZwiftMap({
        el: document.querySelector('#map'),
        worldList,
        zoomMin: 0.05,
        fpsLimit: 60,
    });
    window.zwiftMap = zwiftMap; // debug
    zwiftMap.addEventListener('drag', () => state.voidAutoCenter = true);
    zwiftMap.addEventListener('zoom', () => state.voidAutoCenter = true);
    state.startEnt = new map.MapEntity('start');
    zwiftMap.addEntity(state.startEnt);
    state.endEntity = new map.MapEntity('end');
    state.endEntity.transition.setDuration(0);
    zwiftMap.addEntity(state.endEntity);
    state.cursorEntity = new map.MapEntity('cursor');
    state.cursorEntity.transition.setDuration(0);
    zwiftMap.addEntity(state.cursorEntity);

    contentEl.addEventListener('click', ev => {
        const row = ev.target.closest('table.laps tbody tr, table.segments tbody tr');
        if (!row) {
            return;
        }
        let sel;
        if (row.dataset.segment) {
            sel = state.segments[Number(row.dataset.segment)];
        } else if (row.dataset.lap) {
            sel = state.laps[Number(row.dataset.lap)];
        }
        if (sel) {
            console.log(sel.startIndex, sel.endIndex);
            state.zoomStart = sel.startIndex;
            state.zoomEnd = sel.endIndex;
            zoomableChart.dispatchAction({
                type: 'dataZoom',
                startValue: state.streams.time[sel.startIndex] * 1000,
                endValue: state.streams.time[sel.endIndex] * 1000,
            });
        }
    });
    contentEl.addEventListener('input', async ev => {
        const peakSource = ev.target.closest('select[name="peak-effort-source"]');
        if (!peakSource) {
            return;
        }
        common.settingsStore.set('peakEffortSource', peakSource.value);
        await updateTemplate('.peak-efforts', templates.peakEfforts, {athleteData, settings, peakFormatters});
    });

    zoomableChart.on('brush', ev => elevationChart.dispatchAction({
        type: 'brush',
        fromSauce: true,
        areas: [{
            brushType: 'lineX',
            xAxisIndex: 0,
            coordRange: [
                state.streams.distance[state.zoomStart],
                state.streams.distance[state.zoomEnd]
            ],
        }],
    }));
    zoomableChart.on('dataZoom', ev => elevationChart.dispatchAction({
        type: 'brush',
        fromSauce: true,
        areas: state.zoomStart !== undefined ? [{
            brushType: 'lineX',
            xAxisIndex: 0,
            coordRange: [
                state.streams.distance[state.zoomStart],
                state.streams.distance[state.zoomEnd]
            ],
        }] : [],
    }));
    elevationChart.on('brush', async ev => {
        if (state.brushPath) {
            state.brushPath.elements.forEach(x => x.remove());
            state.brushPath = undefined;
        }
        if (state.zoomStart !== undefined && state.zoomStart < state.zoomEnd) {
            const selection = state.positions.slice(state.zoomStart, state.zoomEnd);
            state.brushPath = zwiftMap.addHighlightLine(selection, 'selection', {color: '#05f'});
        }
        if (!ev.fromSauce) {
            zoomableChart.setOption({
                dataZoom: [{
                    startValue: state.streams.time[state.zoomStart] * 1000,
                    endValue: state.streams.time[state.zoomEnd] * 1000,
                }],
            }, {lazyUpdate: true});
        }
        await updateSelectionStats();
    });
    elevationChart.on('brushEnd', ev => {
        // Only needed for handling a naked click that clears the brush selection
        if (!ev.areas.length) {
            zoomableChart.setOption({
                dataZoom: [{
                    startValue: undefined,
                    endValue: undefined,
                }],
            });
        }
    });

    let axisPointerMutex;
    function proxyAxisPointerEvent(target, ev) {
        if (axisPointerMutex) {
            return;
        }
        axisPointerMutex = true;
        try {
            target.dispatchAction({
                type: 'updateAxisPointer',
                seriesIndex: 0,
                dataIndex: ev.dataIndex,
                currTrigger: ev.dataIndex === undefined  ? 'leave' : undefined,
            });
        } finally {
            axisPointerMutex = false;
        }
    }
    elevationChart.on('updateAxisPointer', ev => {
        proxyAxisPointerEvent(zoomableChart, ev);
        const pos = state.positions[ev.dataIndex];
        state.cursorEntity.toggleHidden(!pos);
        if (pos) {
            state.cursorEntity.setPosition(pos);
        }
    });
    zoomableChart.on('updateAxisPointer', ev => proxyAxisPointerEvent(elevationChart, ev));

    let lastPeaksSig;
    renderer.addCallback(async x => {
        athleteData = x;
        await updateTemplate('.activity-summary', templates.activitySummary, {athleteData});
        if (!document.activeElement || !document.activeElement.closest('.peak-efforts')) {
            const sig = JSON.stringify(athleteData.stats[settings.peakEffortSource || 'power'].peaks);
            if (sig !== lastPeaksSig) {
                lastPeaksSig = sig;
                await updateTemplate('.peak-efforts', templates.peakEfforts,
                                     {athleteData, settings, peakFormatters});
            }
        }
    });

    common.subscribe(`athlete/${athleteIdent}`, x => {
        renderer.setData(x);
        renderer.render();
    });

    renderer.setData(athleteData);
    renderer.render();
    updateLoop();
}


function updateLoop() {
    updateData().finally(() => setTimeout(updateLoop, 2000));
}


async function updateData() {
    if (!common.isVisible()) {
        return;
    }
    const [ad, streams, segments, laps] = await Promise.all([
        common.rpc.getAthleteData(athleteIdent),
        common.rpc.getAthleteStreams(athleteIdent, {startTime: state.timeOfft}),
        common.rpc.getAthleteSegments(athleteIdent, {startTime: state.segmentOfft}),
        common.rpc.getAthleteLaps(athleteIdent, {startTime: state.lapOfft}),
    ]);
    if (!streams || !streams.time.length) {
        return;
    }

    state.timeOfft = streams.time.at(-1) + 1e-6;
    for (const [k, stream] of Object.entries(streams)) {
        if (!state.streams[k]) {
            state.streams[k] = [];
        }
        state.streams[k].push(...stream);
    }
    if (segments.length) {
        state.segments.push(...segments);
        state.segmentOfft = segments.at(-1).start + 1e-6;
        await updateTemplate('table.segments', templates.segments, {athleteData, settings, ...state});
    }
    if (laps.length) {
        state.laps.push(...laps);
        state.lapOfft = laps.at(-1).start + 1e-6;
        await updateTemplate('table.laps', templates.laps, {athleteData, settings, ...state});
    }
    if (ad.courseId !== state.courseId) {
        state.courseId = ad.courseId;
        for (let i = state.laps.length - 1; i >= 0; i--) {
            if (state.laps[i].courseId !== ad.courseId) {
                state.startOffset = state.laps[i].endIndex + 1;
                break;
            }
        }
        zwiftMap.setDragOffset(0, 0);
        state.voidAutoCenter = false; // must follow set-drag-offset
        await zwiftMap.setCourse(ad.courseId);
    }
    if (streams.time.length) {
        for (let i = 0; i < streams.time.length; i++) {
            state.positions.push(zwiftMap.latlngToPosition(streams.latlng[i]));
            rolls.power.add(streams.time[i], streams.power[i]);
        }
        const coursePositions = state.positions.slice(state.startOffset);
        state.startEnt.setPosition(coursePositions[0]);
        state.endEntity.setPosition(coursePositions.at(-1));
        if (state.histPath) {
            state.histPath.elements.forEach(x => x.remove());
        }
        state.histPath = zwiftMap.addHighlightLine(coursePositions, 'history', {layer: 'low'});
        if (!state.voidAutoCenter) {
            centerMap(coursePositions);
        }
    }

    zoomableChart.updateData();
    elevationChart.updateData();
    await updateSelectionStats();
}


export async function settingsMain() {
    common.initInteractionListeners();
    await common.initSettingsForm('form')();
}
