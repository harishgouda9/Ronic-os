import sqlite3
import os
import json
import time

home = os.path.expanduser('~/.ronicos')
workflows_dir = os.path.join(home, 'workflows')
os.makedirs(workflows_dir, exist_ok=True)

wf_id = 'sales-marketing-funnel-001'
wf_name = 'Sales & Marketing Funnel Automation'

nodes = [
    {
        'id': 'lead-capture',
        'name': '1. Lead Capture',
        'kind': 'browser_automation',
        'bot_profile': 'spidy',
        'model': '',
        'prompt': 'Capture lead fields (email, name, job_title, company_size, utm) on form submission & ad click, write to CRM',
        'status': 'idle',
        'latency_ms': 0
    },
    {
        'id': 'lead-qualification',
        'name': '2. Lead Qualification',
        'kind': 'llm_reasoning',
        'bot_profile': 'spidy',
        'model': '',
        'prompt': 'Analyze company size, job title, and engagement to score lead (Hot: >=80, Warm: 50-79, Cold: <50)',
        'status': 'idle',
        'latency_ms': 0
    },
    {
        'id': 'nurture-conversion',
        'name': '3. Nurture & Conversion',
        'kind': 'bot_action',
        'bot_profile': 'spidy',
        'model': '',
        'prompt': 'Send automated SendGrid nurture sequence, offer Calendly demo for hot leads, track purchase conversion',
        'status': 'idle',
        'latency_ms': 0
    },
    {
        'id': 'retention',
        'name': '4. Retention',
        'kind': 'llm_reasoning',
        'bot_profile': 'spidy',
        'model': '',
        'prompt': 'Customer success retention engine: analyze 7-day post-purchase usage data, plan & ARR, dispatch onboarding tasks & upsell offers',
        'status': 'idle',
        'latency_ms': 0
    }
]

triggers = [
    'on_form_submission + on_ad_click',
    'on_lead_captured',
    'on_lead_qualified',
    'on_purchase + 7_days_post_purchase'
]

yaml_lines = [
    f'id: "{wf_id}"',
    f'name: "{wf_name}"',
    'status: "idle"',
    'triggers:'
]
for t in triggers:
    yaml_lines.append(f'  - "{t}"')
yaml_lines.append('nodes:')
for n in nodes:
    yaml_lines.append(f'  - id: "{n["id"]}"')
    yaml_lines.append(f'    name: "{n["name"]}"')
    yaml_lines.append(f'    kind: "{n["kind"]}"')
    yaml_lines.append(f'    bot: "{n["bot_profile"]}"')
    yaml_lines.append(f'    model: "{n["model"]}"')
    yaml_lines.append(f'    status: "{n["status"]}"')
    yaml_lines.append(f'    latency_ms: {n["latency_ms"]}')
    yaml_lines.append(f'    prompt: "{n["prompt"]}"')

yaml_content = '\n'.join(yaml_lines) + '\n'

yaml_file = os.path.join(workflows_dir, 'sales-marketing-funnel.workflow.yaml')
with open(yaml_file, 'w', encoding='utf-8') as f:
    f.write(yaml_content)

db_path = os.path.join(home, 'state.db')
conn = sqlite3.connect(db_path)
c = conn.cursor()

now = int(time.time() * 1000)
nodes_json = json.dumps(nodes)
triggers_json = json.dumps(triggers)

c.execute('''
INSERT OR REPLACE INTO workflows (id, name, yaml_source, nodes_json, triggers_json, current_status, paused_at_node_id, checkpoint_json, updated_at)
VALUES (?, ?, ?, ?, ?, 'idle', NULL, '{}', ?)
''', (wf_id, wf_name, yaml_content, nodes_json, triggers_json, now))

conn.commit()
print('Successfully registered workflow in DB and YAML file!')
count = c.execute('SELECT count(*) FROM workflows').fetchone()[0]
row = c.execute('SELECT id, name, current_status FROM workflows WHERE id = ?', (wf_id,)).fetchone()
print(f'Workflows count in DB: {count}, Registered: {row}')
conn.close()

