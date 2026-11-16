"""Read-only validation of the expert contribution; standard library only."""

import hashlib
import json
import re
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def read_json(relative):
    return json.loads(local_file(relative).read_text(encoding='utf-8'))


def local_file(relative):
    assert isinstance(relative, str) and relative, 'Missing file reference'
    path = (ROOT / relative).resolve()
    assert path.is_relative_to(ROOT), f'Escaping reference: {relative}'
    assert path.is_file(), f'Missing file: {relative}'
    return path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    index = read_json('index.json')
    entries = index['experts']
    assert len({e['id'] for e in entries}) == len(entries), 'Duplicate expert ID'
    counts = Counter(e['source'] for e in entries)
    expected = index['counts']
    assert counts == {'desktop-preset': expected['desktopPresets'],
                      'desktop-team': expected['desktopTeams'],
                      'workbuddy': expected['workbuddyExperts']}
    assert len(entries) == expected['contributedEntries']
    presets = read_json('desktop/presets.json')
    teams = read_json('desktop/teams.json')
    assert len(presets) == expected['desktopPresets']
    assert len(teams) == expected['desktopTeams']
    assert sum(len(t['roles']) + 1 for t in teams) == expected['teamRolesIncludingLeads']
    preset_ids = {p['id'] for p in presets}
    team_ids = {t['id'] for t in teams}
    for preset in presets:
        for field in ('systemPrompt', 'systemPromptEn', 'identity', 'identityEn'):
            assert preset[field].strip(), f'Empty desktop {field}: {preset["id"]}'
    for team in teams:
        for role in [team['lead'], *team['roles']]:
            assert role['systemPrompt'].strip(), f'Empty role: {team["id"]}'
            local_file(team['contributionAvatars'][role['key']])
    for entry in entries:
        assert entry['brand'] == index['brand'], f'Brand mismatch: {entry["id"]}'
        local_file(entry['brand']['mark'])
        avatar = local_file(entry['avatar'])
        if avatar.suffix == '.png':
            assert avatar.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'), f'Invalid PNG: {avatar.name}'
        elif avatar.suffix == '.svg':
            assert ET.parse(avatar).getroot().tag.endswith('svg'), f'Invalid SVG: {avatar.name}'
        else:
            raise AssertionError(f'Unknown avatar format: {avatar.suffix}')
        definition = local_file(entry['definition'])
        if entry['source'] == 'desktop-preset':
            assert entry['sourceId'] in preset_ids
        elif entry['source'] == 'desktop-team':
            assert entry['sourceId'] in team_ids
        else:
            assert digest(definition) == entry['agentSha256'], f'Changed source: {entry["id"]}'
            package = ROOT / entry['package']
            plugin = read_json(entry['package'] + '/.codebuddy-plugin/plugin.json')
            assert plugin['name'] == entry['sourceId']
            assert '灵策智算' in json.dumps(plugin['author'], ensure_ascii=False)
            for field in ('agents', 'skills'):
                for reference in plugin.get(field, []):
                    target = (package / reference).resolve()
                    assert target.is_relative_to(package.resolve()), f'Escaping {field}: {entry["id"]}'
                    assert target.exists(), f'Missing {field}: {entry["id"]}: {reference}'
                    if field == 'skills':
                        assert (target / 'SKILL.md').is_file(), f'Missing bundled skill: {entry["id"]}'
    third_party = read_json('third-party-inventory.json')
    assert len(third_party) == expected['thirdPartyMetadataOnly']
    assert all(e['availability'] == 'metadata-only-pending-redistribution-permission' for e in third_party)
    assert not any('systemPrompt' in e for e in third_party)
    integrity = read_json('integrity.json')
    actual = {p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*') if p.is_file()}
    assert actual == set(integrity['files']) | {'integrity.json'}, 'Unexpected or missing files'
    sensitive = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|'
                           rb'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|'
                           rb'\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}|Bearer\s+[A-Za-z0-9_\-.]{30,}')
    for relative, expected_file in integrity['files'].items():
        path = local_file(relative)
        assert not path.is_symlink(), f'Symlink: {relative}'
        assert path.stat().st_size == expected_file['bytes'], f'Size mismatch: {relative}'
        assert digest(path) == expected_file['sha256'], f'Hash mismatch: {relative}'
        assert path.stat().st_size < 50 * 1024 * 1024, f'Oversized file: {relative}'
        if path.suffix in {'.md', '.json', '.py', '.svg', '.txt'}:
            assert not sensitive.search(path.read_bytes()), f'Credential-shaped content: {relative}'
        assert not any(p in {'.secrets', '.env', '__pycache__'} or p.startswith('.env.')
                       for p in path.relative_to(ROOT).parts), f'Non-delivery file: {relative}'
    print(json.dumps({'result': 'passed', 'entries': len(entries), 'sources': dict(counts),
                      'teamRolesIncludingLeads': expected['teamRolesIncludingLeads'],
                      'thirdPartyMetadataOnly': len(third_party), 'verifiedFiles': len(actual)},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
