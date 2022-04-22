import sauce from '../../shared/sauce/index.mjs';
import common from './common.mjs';

const L = sauce.locale;
const H = L.human;
const num = H.number;
const settingsKey = 'nearby-settings-v2';
const fieldsKey = 'nearby-fields-v2';
let imperial = common.storage.get('/imperialUnits');
L.setImperial(imperial);
let settings;
let fieldStates;
let athleteData = new Map();
let nearbyData;
let hiRow;
let enFields;
let sortBy;
let sortByDir;
let tbody;


function spd(v) {
    const unit = imperial ? 'mph' : 'kph';
    return v ? `${H.pace(v, {precision: 0})}<small>${unit}</small>` : v !== 0 ? '-' : 0;
}


function weight(v) {
    const unit = imperial ? 'lbs' : 'kg';
    return v ? `${H.weight(v, {precision: 0})}<small>${unit}</small>` : v !== 0 ? '-' : 0;
}


function pwr(v) {
    return v ? `${num(v)}<small>w</small>`: v !== 0 ? '-' : 0;
}


function wkg(v) {
    v = v === Infinity ? null : v;
    return v ? `${num(v, {precision: 1, fixed: true})}<small>w/kg</small>`: v !== 0 ? '-' : 0;
}


function hr(v) {
    return v ? `${num(v)}<small>bpm</small>` : '-';
}


function clearSelection() {
    window.getSelection().empty();
}


function getAthleteValue(x, key) {
    const a = athleteData.get(x.athleteId);
    return a && a[key];
}


function getAthleteInitials(x) {
    const name = getAthleteValue(x, 'name');
    if (name && Array.isArray(name)) {
        return name.filter(x => x).map(x => x[0]).join('');
    }
    return '';
}


const fields = [
    {id: 'avatar', defaultEn: true, label: '<img class="fa" src="images/fa/user-circle-solid.svg"/>',
     get: x => getAthleteValue(x, 'avatar'),
     fmt: x => x ? `<a href="${x}" class="avatar" target="_blank"><img src="${x}"/></a>` : ''},
    {id: 'name', defaultEn: true, label: 'Name', get: x => getAthleteValue(x, 'fullname'),
     sanitize: true, fmt: x => x || '-'},
    {id: 'initials', defaultEn: false, label: 'Initials', get: x => getAthleteInitials(x),
     sanitize: true, fmt: x => x || '-'},
    {id: 'id', defaultEn: true, label: 'ID', get: x => x.athleteId,
     fmt: x => `<a title="Open in ZwiftPower" external target="_blank" href="https://zwiftpower.com/profile.php?z=${x}">${x}</a>`},
    {id: 'weight', defaultEn: false, label: 'Weight', get: x => getAthleteValue(x, 'weight'), fmt: weight},
    {id: 'ftp', defaultEn: false, label: 'FTP', get: x => getAthleteValue(x, 'ftp'), fmt: pwr},
    {id: 'tss', defaultEn: false, label: 'TSS', get: x => x.stats.power.tss, fmt: num},

    {id: 'gap', defaultEn: true, label: 'Gap', get: x => x.gap, fmt: x => `${num(x)}s`},

    {id: 'pwr-cur', defaultEn: true, label: 'Pwr', get: x => x.power, fmt: pwr},
    {id: 'wkg-cur', defaultEn: true, label: 'W/kg', get: x => x.power / (x.athlete && x.athlete.weight), fmt: wkg},

    {id: 'pwr-5s', defaultEn: false, label: '5s Pwr', get: x => x.stats.power.smooth[5], fmt: pwr},
    {id: 'wkg-5s', defaultEn: false, label: '5s W/kg', get: x => x.stats.power.smooth[5] / (x.athlete && x.athlete.weight), fmt: wkg},
    {id: 'pwr-15s', defaultEn: false, label: '15s Pwr', get: x => x.stats.power.smooth[15], fmt: pwr},
    {id: 'wkg-15s', defaultEn: false, label: '15s W/kg', get: x => x.stats.power.smooth[15] / (x.athlete && x.athlete.weight), fmt: wkg},
    {id: 'pwr-60s', defaultEn: false, label: '1m Pwr', get: x => x.stats.power.smooth[60], fmt: pwr},
    {id: 'wkg-60s', defaultEn: false, label: '1m W/kg', get: x => x.stats.power.smooth[60] / (x.athlete && x.athlete.weight), fmt: wkg},
    {id: 'pwr-300s', defaultEn: false, label: '5m Pwr', get: x => x.stats.power.smooth[300], fmt: pwr},
    {id: 'wkg-300s', defaultEn: false, label: '5m W/kg', get: x => x.stats.power.smooth[300] / (x.athlete && x.athlete.weight), fmt: wkg},
    {id: 'pwr-1200s', defaultEn: false, label: '20m Pwr', get: x => x.stats.power.smooth[1200], fmt: pwr},
    {id: 'wkg-1200s', defaultEn: false, label: '20m W/kg', get: x => x.stats.power.smooth[1200] / (x.athlete && x.athlete.weight), fmt: wkg},

    {id: 'pwr-avg', defaultEn: true, label: 'Avg Pwr', get: x => x.stats.power.avg, fmt: pwr},
    {id: 'wkg-avg', defaultEn: false, label: 'Avg W/kg', get: x => x.stats.power.avg / (x.athlete && x.athlete.weight), fmt: wkg},

    {id: 'pwr-np', defaultEn: true, label: 'NP', get: x => x.stats.power.np, fmt: pwr},
    {id: 'wkg-np', defaultEn: false, label: 'NP W/kg', get: x => x.stats.power.np / (x.athlete && x.athlete.weight), fmt: wkg},

    {id: 'pwr-max', defaultEn: true, label: 'Max Pwr', get: x => x.stats.power.max || null, fmt: pwr},
    {id: 'wkg-max', defaultEn: false, label: 'Max W/kg', get: x => (x.stats.power.max || null) / (x.athlete && x.athlete.weight), fmt: wkg},

    {id: 'pwr-p5s', defaultEn: false, label: '5s Peak Pwr', get: x => x.stats.power.peaks[5].avg, fmt: pwr},
    {id: 'wkg-p5s', defaultEn: false, label: '5s Peak W/kg', get: x => x.stats.power.peaks[5].avg / (x.athlete && x.athlete.weight), fmt: wkg},
    {id: 'pwr-p15s', defaultEn: false, label: '15s Peak Pwr', get: x => x.stats.power.peaks[15].avg, fmt: pwr},
    {id: 'wkg-p15s', defaultEn: false, label: '15s Peak W/kg', get: x => x.stats.power.peaks[15].avg / (x.athlete && x.athlete.weight), fmt: wkg},
    {id: 'pwr-p60s', defaultEn: false, label: '1m Peak Pwr', get: x => x.stats.power.peaks[60].avg, fmt: pwr},
    {id: 'wkg-p60s', defaultEn: false, label: '1m Peak W/kg', get: x => x.stats.power.peaks[60].avg / (x.athlete && x.athlete.weight), fmt: wkg},
    {id: 'pwr-p300s', defaultEn: true, label: '5m Peak Pwr', get: x => x.stats.power.peaks[300].avg, fmt: pwr},
    {id: 'wkg-p300s', defaultEn: false, label: '5m Peak W/kg', get: x => x.stats.power.peaks[300].avg / (x.athlete && x.athlete.weight), fmt: wkg},
    {id: 'pwr-p1200s', defaultEn: false, label: '20m Peak Pwr', get: x => x.stats.power.peaks[1200].avg, fmt: pwr},
    {id: 'wkg-p1200s', defaultEn: false, label: '20m Peak W/kg', get: x => x.stats.power.peaks[1200].avg / (x.athlete && x.athlete.weight), fmt: wkg},

    {id: 'spd-cur', defaultEn: true, label: 'Spd', get: x => x.speed, fmt: spd},
    {id: 'spd-60s', defaultEn: false, label: '1m Spd', get: x => x.stats.speed.smooth[60], fmt: spd},
    {id: 'spd-avg', defaultEn: true, label: 'Avg Spd', get: x => x.stats.speed.avg, fmt: spd},
    {id: 'spd-p60s', defaultEn: false, label: '1m Peak Spd', get: x => x.stats.speed.peaks[60].avg, fmt: spd},

    {id: 'hr-cur', defaultEn: true, label: 'HR', get: x => x.heartrate || null, fmt: hr},
    {id: 'hr-60s', defaultEn: false, label: '1m HR', get: x => x.stats.hr.smooth[60], fmt: hr},
    {id: 'hr-avg', defaultEn: true, label: 'Avg HR', get: x => x.stats.hr.avg, fmt: hr},
    {id: 'hr-p60s', defaultEn: false, label: '1m Peak HR', get: x => x.stats.hr.peaks[60].avg, fmt: hr},
];


export function main() {
    common.initInteractionListeners({settingsKey});
    let refresh;
    const setRefresh = () => refresh = (settings.refreshInterval || 1) * 1000 - 100; // within 100ms is fine.
    document.addEventListener('settings-updated', ev => {
        settings = ev.data;
        if (common.isElectron && typeof settings.overlayMode === 'boolean') {
            common.rpc('setAppSetting', 'nearbyOverlayMode', settings.overlayMode);
            document.documentElement.classList.toggle('overlay-mode', settings.overlayMode);
        }
        setRefresh();
        render();
        if (nearbyData) {
            renderData(nearbyData);
        }
    });
    window.addEventListener('storage', ev => {
        if (ev.key === fieldsKey) {
            fieldStates = JSON.parse(ev.newValue);
            render();
            if (nearbyData) {
                renderData(nearbyData);
            }
        }
    });

    document.addEventListener('global-settings-updated', ev => {
        if (ev.data.key === '/imperialUnits') {
            L.setImperial(imperial = ev.data.data);
        }
    });
    settings = common.storage.get(settingsKey, {
        autoscroll: true,
        refreshInterval: 1,
        overlayMode: false,
    });
    fieldStates = common.storage.get(fieldsKey, Object.fromEntries(fields.map(x => [x.id, x.defaultEn])));
    if (common.isElectron) {
        common.rpc('getAppSetting', 'nearbyOverlayMode').then(en => {
            if (settings.overlayMode !== en) {
                settings.overlayMode = en;
                common.storage.set(settingsKey, settings);
                document.documentElement.classList.toggle('overlay-mode', en);
            }
        });
    }
    render();
    refresh = setRefresh();
    let lastRefresh = 0;
    common.subscribe('nearby', data => {
        nearbyData = data;
        athleteData = new Map(data.filter(x => x.athlete).map(x => [x.athleteId, x.athlete]));
        const elapsed = Date.now() - lastRefresh;
        if (elapsed >= refresh) {
            lastRefresh = Date.now();
            renderData(data);
        }
    });
}


function render() {
    document.documentElement.classList.toggle('autoscroll', settings.autoscroll);
    enFields = fields.filter(x => fieldStates[x.id]);
    sortBy = common.storage.get('nearby-sort-by', 'gap');
    const isFieldAvail = !!enFields.find(x => x.id === sortBy);
    if (!isFieldAvail) {
        sortBy = enFields[0].id;
    }
    sortByDir = common.storage.get('nearby-sort-dir', 1);
    const table = document.querySelector('#content table');
    tbody = table.querySelector('tbody');
    const theadRow = table.querySelector('thead tr');
    theadRow.innerHTML = '<td></td>' + enFields.map(x =>
        `<td data-id="${x.id}" class="${sortBy === x.id ? 'hi' : ''}">${x.label}</td>`).join('');
    tbody.addEventListener('dblclick', ev => {
        const row = ev.target.closest('tr');
        if (row) {
            clearSelection();
            hiRow = Number(row.dataset.id);
            const oldHi = tbody.querySelector('tr.hi');
            if (oldHi) {
                oldHi.classList.remove('hi');
            }
            if (settings.autoscroll) {
                row.scrollIntoView({block: 'center'});  // forces smooth
                setTimeout(() => row.classList.add('hi'), 200); // smooth scroll hack.
            } else {
                row.classList.add('hi');
            }
        }
    });
    theadRow.addEventListener('click', ev => {
        const col = ev.target.closest('td');
        if (col) {
            const id = col.dataset.id;
            if (id === sortBy) {
                sortByDir = -sortByDir;
                common.storage.set('nearby-sort-dir', sortByDir);
            }
            sortBy = id;
            common.storage.set(`nearby-sort-by`, id);
            for (const td of table.querySelectorAll('td.hi')) {
                td.classList.remove('hi');
            }
            for (const td of table.querySelectorAll(`td[data-id="${sortBy}"]`)) {
                td.classList.add('hi');
            }
            renderData(nearbyData);
        }
    });
    tbody.addEventListener('click', ev => {
        if (ev.target.closest('.edit-link')) {
            ev.stopPropagation();
            const id = Number(ev.target.closest('tr').dataset.id);
            const ath = athleteData.get(id) || {};
            const dialog = document.getElementById('edit-name-dialog');
            const nameInput = dialog.querySelector('input[name="name"]');
            nameInput.value = ath.fullname || '';
            const weightInput = dialog.querySelector('input[name="weight"]');
            weightInput.value = ath.weight || '';
            const ftpInput = dialog.querySelector('input[name="ftp"]');
            ftpInput.value = ath.ftp || '';
            const avatarInput = dialog.querySelector('input[name="avatar"]');
            avatarInput.value = ath.avatar || '';
            dialog.addEventListener('close', async ev => {
                if (dialog.returnValue === 'save') {
                    const [first, ...lasts] = nameInput.value.split(' ').filter(x => x);
                    const last = lasts.length ? lasts.join(' ') : null;
                    const extra = {
                        weight: Number(weightInput.value) || null,
                        ftp: Number(ftpInput.value) || null,
                        avatar: avatarInput.value || null,
                    };
                    const updated = await common.rpc('updateAthlete', id, first, last, extra);
                    athleteData.set(id, updated);
                    console.info(id, updated);
                    renderData(nearbyData);
                }
            }, {once: true});
            dialog.showModal();
        }
    });
}


let nextAnimFrame;
let frames = 0;
const sanitizeEl = document.createElement('span');
function renderData(data) {
    if (!data || !data.length || document.hidden) {
        return;
    }
    const get = enFields.find(x => x.id === sortBy).get;
    data.sort((a, b) => {
        const av = get(a);
        const bv = get(b);
        if (av == bv) {
            return 0;
        } else if (av == null || bv == null) {
            return av == null ? 1 : -1;
        } else {
            return (av < bv ? 1 : -1) * sortByDir;
        }
    });
    const html = data.map(x => {
        const classes = [];
        if (x.watching) {
            classes.push('watching');
        }
        if ((x.watching && !hiRow) || x.athleteId === hiRow) {
            classes.push('hi');
        }
        return `
            <tr data-id="${x.athleteId}" class="${classes.join(' ')}">
                <td>
                    <a class="edit-link" title="Manually edit athlete">
                    <img src="images/fa/edit-duotone.svg"/></a>
                </td>
                ${enFields.map(({id, get, fmt, sanitize}) => {
                    let value = get(x);
                    if (sanitize && value) {
                        sanitizeEl.textContent = value;
                        value = sanitizeEl.innerHTML;
                    }
                    return `<td data-id="${id}" class="${sortBy === id ? 'hi' : ''}">${fmt(value)}</td>`;
                }).join('')}
            </tr>
        `;
    }).join('\n');
    if (nextAnimFrame) {
        cancelAnimationFrame(nextAnimFrame);
    }
    nextAnimFrame = requestAnimationFrame(() => {
        nextAnimFrame = null;
        tbody.innerHTML = html;
        if (!frames++ && settings.autoscroll) {
            queueMicrotask(() => {
                const w = document.querySelector('tr.watching');
                if (w) {
                    w.scrollIntoView({block: 'center'});
                }
            });
        }
    });
}


export async function settingsMain() {
    common.initInteractionListeners();
    fieldStates = common.storage.get(fieldsKey);
    const form = document.querySelector('form#fields');
    form.addEventListener('input', ev => {
        const id = ev.target.name;
        fieldStates[id] = ev.target.checked;
        common.storage.set(fieldsKey, fieldStates);
    });
    const fieldsHtml = fields.map(x => `
        <label>
            <key>${x.label}</key>
            <input type="checkbox" name="${x.id}" ${fieldStates[x.id] ? 'checked' : ''}/>
        </label>
    `).join('');
    form.innerHTML = fieldsHtml;
    await common.initSettingsForm('form#options', {settingsKey});
}
